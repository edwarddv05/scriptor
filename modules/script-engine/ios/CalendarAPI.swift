import EventKit
import EventKitUI
import Foundation
import UIKit

/// Calendar, CalendarEvent, Reminder and RecurrenceRule (EventKit). Dates cross as milliseconds.
enum CalendarAPI {
  static let store = EKEventStore()

  // MARK: Access

  private static func hasAccess(_ entity: EKEntityType) -> Bool {
    let status = EKEventStore.authorizationStatus(for: entity)
    if #available(iOS 17.0, *) { return status == .fullAccess }
    return status.rawValue == 3  // .authorized before iOS 17
  }

  static func requestAccess(_ entity: EKEntityType, _ completion: @escaping (Error?) -> Void) {
    if hasAccess(entity) { return completion(nil) }
    let handler: (Bool, Error?) -> Void = { ok, error in
      completion(ok ? nil : error ?? ScriptError("\(entity == .event ? "Calendar" : "Reminders") access denied. Enable it in Settings > Scriptor."))
    }
    if #available(iOS 17.0, *) {
      if entity == .event { store.requestFullAccessToEvents(completion: handler) } else { store.requestFullAccessToReminders(completion: handler) }
    } else {
      store.requestAccess(to: entity, completion: handler)
    }
  }

  /// Blocking variant for the synchronous save/remove calls. Runs on the script's queue.
  private static func ensureAccess(_ entity: EKEntityType) throws {
    if hasAccess(entity) { return }
    let semaphore = DispatchSemaphore(value: 0)
    var failure: Error?
    requestAccess(entity) { error in
      failure = error
      semaphore.signal()
    }
    semaphore.wait()
    if let failure { throw failure }
  }

  private static func entity(_ text: String?) -> EKEntityType { text == "reminder" ? .reminder : .event }

  static func register(_ r: NativeRegistry) {
    r.async("cal.calendars") { _, a, done in
      let kind = entity(a.optString(0))
      requestAccess(kind) { error in
        if let error { return done(.failure(error)) }
        done(.success(store.calendars(for: kind).map(describe)))
      }
    }

    r.async("cal.defaultCalendar") { _, a, done in
      let kind = entity(a.optString(0))
      requestAccess(kind) { error in
        if let error { return done(.failure(error)) }
        let calendar = kind == .event ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders()
        guard let calendar else { return done(.failure(ScriptError("There is no default calendar"))) }
        done(.success(describe(calendar)))
      }
    }

    r.async("cal.createCalendar") { _, a, done in
      let kind = entity(a.optString(0))
      let title = a.optString(1) ?? ""
      requestAccess(kind) { error in
        if let error { return done(.failure(error)) }
        let calendar = EKCalendar(for: kind, eventStore: store)
        calendar.title = title
        let fallback = kind == .event ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders()
        calendar.source = fallback?.source ?? store.sources.first(where: { $0.sourceType == .local }) ?? store.sources.first
        do {
          try store.saveCalendar(calendar, commit: true)
          done(.success(describe(calendar)))
        } catch { done(.failure(error)) }
      }
    }

    r.sync("cal.saveCalendar") { _, a in
      let spec = a.dict(0)
      guard let id = spec["identifier"] as? String, let calendar = store.calendar(withIdentifier: id) else {
        throw ScriptError("Calendar not found")
      }
      if let title = spec["title"] as? String { calendar.title = title }
      if let hex = spec["color"] as? String, let color = Style.color(["hex": hex]) { calendar.cgColor = color.cgColor }
      try store.saveCalendar(calendar, commit: true)
      return nil
    }

    r.sync("cal.removeCalendar") { _, a in
      guard let calendar = store.calendar(withIdentifier: try a.string(0)) else { throw ScriptError("Calendar not found") }
      try store.removeCalendar(calendar, commit: true)
      return nil
    }

    // (entity, multiple) -> [calendar]
    r.async("cal.presentPicker") { _, a, done in
      let kind = entity(a.optString(0))
      let multiple = a.bool(1, false)
      requestAccess(kind) { error in
        if let error { return done(.failure(error)) }
        DispatchQueue.main.async {
          let chooser = EKCalendarChooser(
            selectionStyle: multiple ? .multiple : .single, displayStyle: .allCalendars, entityType: kind, eventStore: store)
          chooser.showsDoneButton = true
          chooser.showsCancelButton = true
          let delegate = CalendarChooserDelegate(done: done)
          chooser.delegate = delegate
          let nav = UINavigationController(rootViewController: chooser)
          Presenter.present(nav, retaining: delegate)
          delegate.container = nav
        }
      }
    }

    // MARK: Events

    // (startMs, endMs, calendarIds|null) -> [event]
    r.async("cal.events") { _, a, done in
      let start = Date(timeIntervalSince1970: a.double(0, 0) / 1000)
      let end = Date(timeIntervalSince1970: a.double(1, 0) / 1000)
      let ids = a.value(2) == nil ? nil : a.stringArray(2)
      requestAccess(.event) { error in
        if let error { return done(.failure(error)) }
        let calendars = ids.map { $0.compactMap { store.calendar(withIdentifier: $0) } }
        let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
        let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
        done(.success(events.map(describe)))
      }
    }

    r.sync("cal.saveEvent") { _, a in
      try ensureAccess(.event)
      let spec = a.dict(0)
      let event = (spec["identifier"] as? String).flatMap { store.event(withIdentifier: $0) } ?? EKEvent(eventStore: store)
      apply(spec, to: event)
      try store.save(event, span: .thisEvent, commit: true)
      return describe(event)
    }

    r.sync("cal.removeEvent") { _, a in
      try ensureAccess(.event)
      guard let event = store.event(withIdentifier: try a.string(0)) else { return nil }
      try store.remove(event, span: .thisEvent, commit: true)
      return nil
    }

    // (spec | null) -> event | null. Shows the system editor; null spec creates a new event.
    r.async("cal.presentEdit") { _, a, done in
      let spec: [String: Any]? = a.value(0) == nil ? nil : a.dict(0)
      requestAccess(.event) { error in
        if let error { return done(.failure(error)) }
        DispatchQueue.main.async {
          let event = (spec?["identifier"] as? String).flatMap { store.event(withIdentifier: $0) } ?? EKEvent(eventStore: store)
          if let spec { apply(spec, to: event) } else { event.calendar = store.defaultCalendarForNewEvents }
          let editor = EKEventEditViewController()
          editor.eventStore = store
          editor.event = event
          let delegate = EventEditDelegate(done: done)
          editor.editViewDelegate = delegate
          Presenter.present(editor, retaining: delegate)
        }
      }
    }

    // MARK: Reminders

    // (calendarIds|null) -> [reminder]. The prelude filters by due/completion date.
    r.async("cal.reminders") { _, a, done in
      let ids = a.value(0) == nil ? nil : a.stringArray(0)
      requestAccess(.reminder) { error in
        if let error { return done(.failure(error)) }
        let calendars = ids.map { $0.compactMap { store.calendar(withIdentifier: $0) } }
        store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { reminders in
          done(.success((reminders ?? []).map(describe)))
        }
      }
    }

    r.sync("cal.saveReminder") { _, a in
      try ensureAccess(.reminder)
      let spec = a.dict(0)
      let reminder = (spec["identifier"] as? String).flatMap { store.calendarItem(withIdentifier: $0) as? EKReminder }
        ?? EKReminder(eventStore: store)
      apply(spec, to: reminder)
      try store.save(reminder, commit: true)
      return describe(reminder)
    }

    r.sync("cal.removeReminder") { _, a in
      try ensureAccess(.reminder)
      guard let reminder = store.calendarItem(withIdentifier: try a.string(0)) as? EKReminder else { return nil }
      try store.remove(reminder, commit: true)
      return nil
    }
  }

  // MARK: Conversion

  private static func ms(_ date: Date?) -> Any { date.map { $0.timeIntervalSince1970 * 1000 as Any } ?? NSNull() }
  private static func date(_ any: Any?) -> Date? { num(any).map { Date(timeIntervalSince1970: $0 / 1000) } }

  private static func hex(_ cg: CGColor?) -> String {
    guard let cg else { return "808080" }
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, al: CGFloat = 0
    UIColor(cgColor: cg).getRed(&r, green: &g, blue: &b, alpha: &al)
    return String(format: "%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
  }

  static func describe(_ c: EKCalendar) -> [String: Any] {
    var availabilities: [String] = []
    let supported = c.supportedEventAvailabilities
    if supported.contains(.busy) { availabilities.append("busy") }
    if supported.contains(.free) { availabilities.append("free") }
    if supported.contains(.tentative) { availabilities.append("tentative") }
    if supported.contains(.unavailable) { availabilities.append("unavailable") }
    return [
      "identifier": c.calendarIdentifier, "title": c.title, "isSubscribed": c.isSubscribed,
      "allowsContentModifications": c.allowsContentModifications, "color": hex(c.cgColor),
      "entity": c.allowedEntityTypes.contains(.reminder) ? "reminder" : "event", "availabilities": availabilities,
    ]
  }

  private static let availabilityNames: [EKEventAvailability: String] = [
    .notSupported: "notSupported", .busy: "busy", .free: "free", .tentative: "tentative", .unavailable: "unavailable",
  ]

  static func describe(_ e: EKEvent) -> [String: Any] {
    let statuses = ["unknown", "pending", "accepted", "declined", "tentative", "delegated", "completed", "inProcess"]
    let types = ["unknown", "person", "room", "resource", "group"]
    let roles = ["unknown", "required", "optional", "chair", "nonParticipant"]
    let attendees: [[String: Any]] = (e.attendees ?? []).map { p in
      [
        "isCurrentUser": p.isCurrentUser, "name": p.name ?? "",
        "status": statuses[min(p.participantStatus.rawValue, statuses.count - 1)],
        "type": types[min(p.participantType.rawValue, types.count - 1)],
        "role": roles[min(p.participantRole.rawValue, roles.count - 1)],
      ]
    }
    var out: [String: Any] = [
      "identifier": e.eventIdentifier ?? e.calendarItemIdentifier, "title": e.title ?? "", "location": e.location ?? "",
      "notes": e.notes ?? "", "startDate": ms(e.startDate), "endDate": ms(e.endDate), "isAllDay": e.isAllDay,
      "availability": availabilityNames[e.availability] ?? "busy", "timeZone": e.timeZone.map { $0.identifier as Any } ?? NSNull(),
      "attendees": attendees, "recurrenceRules": (e.recurrenceRules ?? []).map(describe),
    ]
    if let c = e.calendar { out["calendar"] = describe(c) }
    return out
  }

  static func describe(_ r: EKReminder) -> [String: Any] {
    let due = r.dueDateComponents
    var out: [String: Any] = [
      "identifier": r.calendarItemIdentifier, "title": r.title ?? "", "notes": r.notes ?? "",
      "isCompleted": r.isCompleted, "priority": r.priority,
      "dueDate": ms(due.flatMap { Calendar.current.date(from: $0) }),
      "dueDateIncludesTime": due?.hour != nil,
      "completionDate": ms(r.completionDate), "creationDate": ms(r.creationDate),
      "recurrenceRules": (r.recurrenceRules ?? []).map(describe),
    ]
    if let c = r.calendar { out["calendar"] = describe(c) }
    return out
  }

  private static let frequencies: [EKRecurrenceFrequency: String] = [.daily: "daily", .weekly: "weekly", .monthly: "monthly", .yearly: "yearly"]

  static func describe(_ rule: EKRecurrenceRule) -> [String: Any] {
    var out: [String: Any] = ["frequency": frequencies[rule.frequency] ?? "daily", "interval": rule.interval]
    if let end = rule.recurrenceEnd {
      if let d = end.endDate { out["endDate"] = ms(d) } else { out["occurrenceCount"] = end.occurrenceCount }
    }
    if let days = rule.daysOfTheWeek { out["daysOfTheWeek"] = days.map { $0.dayOfTheWeek.rawValue } }
    if let v = rule.daysOfTheMonth { out["daysOfTheMonth"] = v }
    if let v = rule.monthsOfTheYear { out["monthsOfTheYear"] = v }
    if let v = rule.weeksOfTheYear { out["weeksOfTheYear"] = v }
    if let v = rule.daysOfTheYear { out["daysOfTheYear"] = v }
    if let v = rule.setPositions { out["setPositions"] = v }
    return out
  }

  private static func rule(_ d: [String: Any]) -> EKRecurrenceRule {
    let frequency = frequencies.first { $0.value == (d["frequency"] as? String) }?.key ?? .daily
    let numbers = { (key: String) -> [NSNumber]? in
      guard let arr = d[key] as? [Any], !arr.isEmpty else { return nil }
      return arr.compactMap { $0 as? NSNumber }
    }
    let days = numbers("daysOfTheWeek")?.compactMap { EKWeekday(rawValue: $0.intValue).map { EKRecurrenceDayOfWeek($0) } }
    var end: EKRecurrenceEnd?
    if let endDate = date(d["endDate"]) {
      end = EKRecurrenceEnd(end: endDate)
    } else if let count = num(d["occurrenceCount"]) {
      end = EKRecurrenceEnd(occurrenceCount: Int(count))
    }
    return EKRecurrenceRule(
      recurrenceWith: frequency, interval: max(Int(num(d["interval"]) ?? 1), 1), daysOfTheWeek: days,
      daysOfTheMonth: numbers("daysOfTheMonth"), monthsOfTheYear: numbers("monthsOfTheYear"),
      weeksOfTheYear: numbers("weeksOfTheYear"), daysOfTheYear: numbers("daysOfTheYear"),
      setPositions: numbers("setPositions"), end: end)
  }

  private static func applyRules(_ spec: [String: Any], to item: EKCalendarItem) {
    guard let rules = spec["recurrenceRules"] as? [[String: Any]] else { return }
    (item.recurrenceRules ?? []).forEach { item.removeRecurrenceRule($0) }
    rules.map(rule).forEach { item.addRecurrenceRule($0) }
  }

  private static func apply(_ spec: [String: Any], to event: EKEvent) {
    event.title = spec["title"] as? String
    event.location = spec["location"] as? String
    event.notes = spec["notes"] as? String
    if let start = date(spec["startDate"]) { event.startDate = start }
    if let end = date(spec["endDate"]) { event.endDate = end }
    event.isAllDay = (spec["isAllDay"] as? Bool) ?? false
    if let name = spec["availability"] as? String, let a = availabilityNames.first(where: { $0.value == name })?.key {
      event.availability = a
    }
    if let tz = spec["timeZone"] as? String { event.timeZone = TimeZone(identifier: tz) }
    if let id = spec["calendar"] as? String, let c = store.calendar(withIdentifier: id) {
      event.calendar = c
    } else if event.calendar == nil {
      event.calendar = store.defaultCalendarForNewEvents
    }
    applyRules(spec, to: event)
  }

  private static func apply(_ spec: [String: Any], to reminder: EKReminder) {
    reminder.title = spec["title"] as? String
    reminder.notes = spec["notes"] as? String
    reminder.isCompleted = (spec["isCompleted"] as? Bool) ?? false
    reminder.priority = Int(num(spec["priority"]) ?? 0)
    if let due = date(spec["dueDate"]) {
      let includesTime = (spec["dueDateIncludesTime"] as? Bool) ?? true
      let units: Set<Calendar.Component> = includesTime ? [.year, .month, .day, .hour, .minute, .second] : [.year, .month, .day]
      reminder.dueDateComponents = Calendar.current.dateComponents(units, from: due)
    } else {
      reminder.dueDateComponents = nil
    }
    if let id = spec["calendar"] as? String, let c = store.calendar(withIdentifier: id) {
      reminder.calendar = c
    } else if reminder.calendar == nil {
      reminder.calendar = store.defaultCalendarForNewReminders()
    }
    applyRules(spec, to: reminder)
  }
}

private final class CalendarChooserDelegate: NSObject, EKCalendarChooserDelegate {
  private var done: Completion?
  weak var container: UIViewController?
  init(done: @escaping Completion) { self.done = done }

  private func finish(_ chooser: EKCalendarChooser, _ calendars: Set<EKCalendar>) {
    let result = calendars.map(CalendarAPI.describe)
    (container ?? chooser).dismiss(animated: true)
    if let container { Presenter.release(container) }
    done?(.success(result))
    done = nil
  }

  func calendarChooserDidFinish(_ chooser: EKCalendarChooser) { finish(chooser, chooser.selectedCalendars) }
  func calendarChooserDidCancel(_ chooser: EKCalendarChooser) { finish(chooser, []) }
}

private final class EventEditDelegate: NSObject, EKEventEditViewDelegate {
  private var done: Completion?
  init(done: @escaping Completion) { self.done = done }

  func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
    let result: Any? = action == .saved ? controller.event.map(CalendarAPI.describe) : nil
    controller.dismiss(animated: true)
    Presenter.release(controller)
    done?(.success(result))
    done = nil
  }
}
