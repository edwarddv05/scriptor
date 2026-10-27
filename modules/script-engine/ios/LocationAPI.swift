import Contacts
import CoreLocation
import Foundation

/// Location.current() and geocoding.
enum LocationAPI {
  static func register(_ r: NativeRegistry) {
    // (accuracy) -> { latitude, longitude, altitude, horizontalAccuracy, verticalAccuracy }
    r.async("location.current") { _, a, done in
      let accuracy: CLLocationAccuracy
      switch a.optString(0) {
      case "ten": accuracy = kCLLocationAccuracyNearestTenMeters
      case "hundred": accuracy = kCLLocationAccuracyHundredMeters
      case "kilometer": accuracy = kCLLocationAccuracyKilometer
      case "threeKilometers": accuracy = kCLLocationAccuracyThreeKilometers
      default: accuracy = kCLLocationAccuracyBest
      }
      DispatchQueue.main.async { LocationRequest(accuracy: accuracy, done: done).start() }
    }

    // (latitude, longitude, locale) -> [placemark]
    r.async("location.reverseGeocode") { _, a, done in
      let location = CLLocation(latitude: a.double(0, 0), longitude: a.double(1, 0))
      let locale = a.optString(2).map { Locale(identifier: $0) }
      CLGeocoder().reverseGeocodeLocation(location, preferredLocale: locale) { marks, error in
        if let error { return done(.failure(error)) }
        done(.success((marks ?? []).map(describe)))
      }
    }

    // (address, locale) -> [placemark]
    r.async("location.geocode") { _, a, done in
      let address = a.optString(0) ?? ""
      let locale = a.optString(1).map { Locale(identifier: $0) }
      CLGeocoder().geocodeAddressString(address, in: nil, preferredLocale: locale) { marks, error in
        if let error { return done(.failure(error)) }
        done(.success((marks ?? []).map(describe)))
      }
    }
  }

  static func describe(_ p: CLPlacemark) -> [String: Any] {
    var out: [String: Any] = [:]
    let fields: [(String, String?)] = [
      ("name", p.name), ("thoroughfare", p.thoroughfare), ("subThoroughfare", p.subThoroughfare),
      ("locality", p.locality), ("subLocality", p.subLocality), ("administrativeArea", p.administrativeArea),
      ("subAdministrativeArea", p.subAdministrativeArea), ("postalCode", p.postalCode), ("country", p.country),
      ("isoCountryCode", p.isoCountryCode), ("ocean", p.ocean), ("inlandWater", p.inlandWater),
      ("timeZone", p.timeZone?.identifier),
    ]
    for (k, v) in fields { out[k] = v.map { $0 as Any } ?? NSNull() }
    out["areasOfInterest"] = p.areasOfInterest ?? []
    if let loc = p.location {
      out["location"] = ["latitude": loc.coordinate.latitude, "longitude": loc.coordinate.longitude, "altitude": loc.altitude]
    }
    if let a = p.postalAddress {
      out["postalAddress"] = [
        "street": a.street, "city": a.city, "state": a.state, "postalCode": a.postalCode, "country": a.country,
        "isoCountryCode": a.isoCountryCode, "subLocality": a.subLocality, "subAdministrativeArea": a.subAdministrativeArea,
      ]
    }
    return out
  }
}

/// One location request; keeps itself alive until it answers.
private final class LocationRequest: NSObject, CLLocationManagerDelegate {
  private static var active: Set<LocationRequest> = []
  private let manager = CLLocationManager()
  private var done: Completion?
  private var requested = false

  init(accuracy: CLLocationAccuracy, done: @escaping Completion) {
    self.done = done
    super.init()
    manager.desiredAccuracy = accuracy
  }

  func start() {
    LocationRequest.active.insert(self)
    manager.delegate = self
    proceed()
  }

  private func proceed() {
    switch manager.authorizationStatus {
    case .notDetermined:
      manager.requestWhenInUseAuthorization()
    case .denied, .restricted:
      finish(.failure(ScriptError("Location access denied. Enable it in Settings > Scriptor.")))
    default:
      guard !requested else { return }
      requested = true
      manager.requestLocation()
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus != .notDetermined { proceed() }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let loc = locations.last else { return }
    finish(.success([
      "latitude": loc.coordinate.latitude, "longitude": loc.coordinate.longitude, "altitude": loc.altitude,
      "horizontalAccuracy": loc.horizontalAccuracy, "verticalAccuracy": loc.verticalAccuracy,
    ]))
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    finish(.failure(error))
  }

  private func finish(_ result: Result<Any?, Error>) {
    guard let done else { return }
    self.done = nil
    manager.delegate = nil
    done(result)
    LocationRequest.active.remove(self)
  }
}
