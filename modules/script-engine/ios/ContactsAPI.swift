import Contacts
import Foundation

/// Contact, ContactsContainer and ContactsGroup. Changes are queued in JS and applied in one
/// CNSaveRequest by Contact.persistChanges(). Notes are skipped: they need an entitlement.
enum ContactsAPI {
  static let store = CNContactStore()

  private static let keys: [CNKeyDescriptor] = [
    CNContactNamePrefixKey, CNContactGivenNameKey, CNContactMiddleNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
    CNContactBirthdayKey, CNContactImageDataAvailableKey, CNContactEmailAddressesKey, CNContactPhoneNumbersKey,
    CNContactPostalAddressesKey, CNContactSocialProfilesKey, CNContactUrlAddressesKey, CNContactDatesKey,
    CNContactOrganizationNameKey, CNContactDepartmentNameKey, CNContactJobTitleKey,
  ] as [CNKeyDescriptor]

  private static func ensureAccess() throws {
    let status = CNContactStore.authorizationStatus(for: .contacts)
    // 3 = authorized, 4 = limited (iOS 18).
    if status.rawValue == 3 || status.rawValue == 4 { return }
    if status == .denied || status == .restricted {
      throw ScriptError("Contacts access denied. Enable it in Settings > Scriptor.")
    }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    store.requestAccess(for: .contacts) { ok, _ in
      granted = ok
      semaphore.signal()
    }
    semaphore.wait()
    if !granted { throw ScriptError("Contacts access denied") }
  }

  /// Contacts calls block while iOS asks for permission, so run them off the script's queue.
  private static func background(_ done: @escaping Completion, _ body: @escaping () throws -> Any?) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        try ensureAccess()
        done(.success(try body()))
      } catch { done(.failure(error)) }
    }
  }

  static func register(_ r: NativeRegistry) {
    r.async("contacts.containers") { _, _, done in
      background(done) {
        try store.containers(matching: nil).map { ["identifier": $0.identifier, "name": $0.name] }
      }
    }

    r.async("contacts.defaultContainer") { _, _, done in
      background(done) {
        let id = store.defaultContainerIdentifier()
        let container = try store.containers(matching: CNContainer.predicateForContainers(withIdentifiers: [id])).first
        return ["identifier": id, "name": container?.name ?? ""]
      }
    }

    // (containerIds | null) -> [group]
    r.async("contacts.groups") { _, a, done in
      let ids = a.value(0) == nil ? nil : a.stringArray(0)
      background(done) {
        let groups = try ids.map { ids in
          try ids.flatMap { try store.groups(matching: CNGroup.predicateForGroupsInContainer(withIdentifier: $0)) }
        } ?? store.groups(matching: nil)
        return groups.map { ["identifier": $0.identifier, "name": $0.name] }
      }
    }

    // ({ containers?, groups? }) -> [contact]
    r.async("contacts.fetch") { _, a, done in
      let opts = a.dict(0)
      let groupIds = opts["groups"] as? [String]
      let containerIds = opts["containers"] as? [String]
      background(done) {
        var predicates: [NSPredicate] = []
        if let groupIds {
          predicates = groupIds.map { CNContact.predicateForContactsInGroup(withIdentifier: $0) }
        } else {
          let ids = try containerIds ?? store.containers(matching: nil).map { $0.identifier }
          predicates = ids.map { CNContact.predicateForContactsInContainer(withIdentifier: $0) }
        }
        var seen = Set<String>()
        var out: [[String: Any]] = []
        for predicate in predicates {
          for c in try store.unifiedContacts(matching: predicate, keysToFetch: keys) where seen.insert(c.identifier).inserted {
            out.append(describe(c))
          }
        }
        return out
      }
    }

    // (identifier) -> path of the contact's photo, or null
    r.sync("contacts.image") { _, a in
      try ensureAccess()
      let contact = try store.unifiedContact(withIdentifier: try a.string(0), keysToFetch: [CNContactImageDataKey as CNKeyDescriptor])
      guard let data = contact.imageData else { return nil }
      let out = Paths.tempFile("jpg")
      try data.write(to: out)
      return out.path
    }

    // ([{ op, container, item, member }]) -> [identifier | null], one per op
    r.async("contacts.persist") { _, a, done in
      let ops = (a.value(0)?.toArray() as? [[String: Any]]) ?? []
      background(done) { try persist(ops) }
    }
  }

  // MARK: Persisting

  private static func persist(_ ops: [[String: Any]]) throws -> [Any] {
    let request = CNSaveRequest()
    var newContacts: [String: CNMutableContact] = [:]
    var newGroups: [String: CNMutableGroup] = [:]
    var created: [Int: AnyObject] = [:]

    func existingContact(_ id: String) throws -> CNMutableContact {
      guard let c = try store.unifiedContact(withIdentifier: id, keysToFetch: keys).mutableCopy() as? CNMutableContact else {
        throw ScriptError("Contact not found")
      }
      return c
    }
    func existingGroup(_ id: String) throws -> CNMutableGroup {
      guard let g = try store.groups(matching: CNGroup.predicateForGroups(withIdentifiers: [id])).first?.mutableCopy() as? CNMutableGroup else {
        throw ScriptError("Group not found")
      }
      return g
    }
    func contactRef(_ d: [String: Any]?) throws -> CNContact {
      if let ref = d?["ref"] as? String, let c = newContacts[ref] { return c }
      guard let id = d?["identifier"] as? String else { throw ScriptError("The contact has not been saved yet") }
      return try existingContact(id)
    }
    func groupRef(_ d: [String: Any]) throws -> CNGroup {
      if let ref = d["ref"] as? String, let g = newGroups[ref] { return g }
      guard let id = d["identifier"] as? String else { throw ScriptError("The group has not been saved yet") }
      return try existingGroup(id)
    }

    for (i, op) in ops.enumerated() {
      let item = (op["item"] as? [String: Any]) ?? [:]
      let container = op["container"] as? String
      switch op["op"] as? String {
      case "add":
        let c = CNMutableContact()
        apply(item, to: c)
        request.add(c, toContainerWithIdentifier: container)
        if let ref = item["ref"] as? String { newContacts[ref] = c }
        created[i] = c
      case "update":
        guard let id = item["identifier"] as? String else { throw ScriptError("Contact.update needs a saved contact") }
        let c = try existingContact(id)
        apply(item, to: c)
        request.update(c)
      case "delete":
        guard let id = item["identifier"] as? String else { continue }
        request.delete(try existingContact(id))
      case "addGroup":
        let g = CNMutableGroup()
        g.name = (item["name"] as? String) ?? ""
        request.add(g, toContainerWithIdentifier: container)
        if let ref = item["ref"] as? String { newGroups[ref] = g }
        created[i] = g
      case "updateGroup":
        guard let id = item["identifier"] as? String else { throw ScriptError("ContactsGroup.update needs a saved group") }
        let g = try existingGroup(id)
        g.name = (item["name"] as? String) ?? g.name
        request.update(g)
      case "deleteGroup":
        guard let id = item["identifier"] as? String else { continue }
        request.delete(try existingGroup(id))
      case "addMember":
        request.addMember(try contactRef(op["member"] as? [String: Any]), to: try groupRef(item))
      case "removeMember":
        request.removeMember(try contactRef(op["member"] as? [String: Any]), from: try groupRef(item))
      default:
        break
      }
    }
    try store.execute(request)
    return ops.indices.map { i -> Any in
      switch created[i] {
      case let c as CNContact: return c.identifier
      case let g as CNGroup: return g.identifier
      default: return NSNull()
      }
    }
  }

  // MARK: Conversion

  private static func labeled(_ label: String?) -> [String: Any] {
    ["label": label ?? "", "localizedLabel": label.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) } ?? ""]
  }

  private static func ms(_ c: DateComponents?) -> Any {
    guard let c, let date = Calendar.current.date(from: c) else { return NSNull() }
    return date.timeIntervalSince1970 * 1000
  }

  static func describe(_ c: CNContact) -> [String: Any] {
    var out: [String: Any] = [
      "identifier": c.identifier, "namePrefix": c.namePrefix, "givenName": c.givenName, "middleName": c.middleName,
      "familyName": c.familyName, "nickname": c.nickname, "organizationName": c.organizationName,
      "departmentName": c.departmentName, "jobTitle": c.jobTitle, "birthday": ms(c.birthday),
      "isImageAvailable": c.imageDataAvailable,
    ]
    out["emailAddresses"] = c.emailAddresses.map { labeled($0.label).merging(["identifier": $0.identifier, "value": $0.value as String]) { $1 } }
    out["phoneNumbers"] = c.phoneNumbers.map { labeled($0.label).merging(["identifier": $0.identifier, "value": $0.value.stringValue]) { $1 } }
    out["urlAddresses"] = c.urlAddresses.map { labeled($0.label).merging(["identifier": $0.identifier, "value": $0.value as String]) { $1 } }
    out["postalAddresses"] = c.postalAddresses.map { v -> [String: Any] in
      let p = v.value
      return labeled(v.label).merging([
        "identifier": v.identifier, "street": p.street, "city": p.city, "state": p.state, "postalCode": p.postalCode,
        "country": p.country, "isoCountryCode": p.isoCountryCode,
      ]) { $1 }
    }
    out["socialProfiles"] = c.socialProfiles.map { v -> [String: Any] in
      let p = v.value
      return labeled(v.label).merging([
        "identifier": v.identifier, "service": p.service, "url": p.urlString, "userIdentifier": p.userIdentifier, "username": p.username,
      ]) { $1 }
    }
    out["dates"] = c.dates.map { labeled($0.label).merging(["identifier": $0.identifier, "value": ms($0.value as DateComponents)]) { $1 } }
    return out
  }

  private static func list(_ any: Any?) -> [[String: Any]]? { any as? [[String: Any]] }
  private static func label(_ d: [String: Any]) -> String? { (d["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
  private static func dateComponents(_ any: Any?) -> DateComponents? {
    guard let ms = num(any) else { return nil }
    return Calendar.current.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: ms / 1000))
  }

  private static func apply(_ d: [String: Any], to c: CNMutableContact) {
    if let v = d["namePrefix"] as? String { c.namePrefix = v }
    if let v = d["givenName"] as? String { c.givenName = v }
    if let v = d["middleName"] as? String { c.middleName = v }
    if let v = d["familyName"] as? String { c.familyName = v }
    if let v = d["nickname"] as? String { c.nickname = v }
    if let v = d["organizationName"] as? String { c.organizationName = v }
    if let v = d["departmentName"] as? String { c.departmentName = v }
    if let v = d["jobTitle"] as? String { c.jobTitle = v }
    if d.keys.contains("birthday") { c.birthday = dateComponents(d["birthday"]) }
    if let v = list(d["emailAddresses"]) {
      c.emailAddresses = v.map { CNLabeledValue(label: label($0), value: (($0["value"] as? String) ?? "") as NSString) }
    }
    if let v = list(d["phoneNumbers"]) {
      c.phoneNumbers = v.map { CNLabeledValue(label: label($0), value: CNPhoneNumber(stringValue: ($0["value"] as? String) ?? "")) }
    }
    if let v = list(d["urlAddresses"]) {
      c.urlAddresses = v.map { CNLabeledValue(label: label($0), value: (($0["value"] as? String) ?? "") as NSString) }
    }
    if let v = list(d["postalAddresses"]) {
      c.postalAddresses = v.map { item in
        let p = CNMutablePostalAddress()
        p.street = (item["street"] as? String) ?? ""
        p.city = (item["city"] as? String) ?? ""
        p.state = (item["state"] as? String) ?? ""
        p.postalCode = (item["postalCode"] as? String) ?? ""
        p.country = (item["country"] as? String) ?? ""
        p.isoCountryCode = (item["isoCountryCode"] as? String) ?? ""
        return CNLabeledValue(label: label(item), value: p as CNPostalAddress)
      }
    }
    if let v = list(d["socialProfiles"]) {
      c.socialProfiles = v.map { item in
        CNLabeledValue(label: label(item), value: CNSocialProfile(
          urlString: item["url"] as? String, username: item["username"] as? String,
          userIdentifier: item["userIdentifier"] as? String, service: item["service"] as? String))
      }
    }
    if let v = list(d["dates"]) {
      c.dates = v.compactMap { item in
        dateComponents(item["value"]).map { CNLabeledValue(label: label(item), value: $0 as NSDateComponents) }
      }
    }
    if let path = d["image"] as? String {
      c.imageData = path.isEmpty ? nil : try? Data(contentsOf: Paths.resolve(path))
    }
  }
}
