import Foundation

/// The key the APNs body carries Clave's payload under, beside `aps`.
public let apnsPayloadKey = "clave"

/// The payload of a push, read from the `clave` key of the notification's
/// user info (a dictionary, or the same as a JSON string) through the
/// contract's decoder; nil when nothing readable is there (a push that is
/// not Clave's). An action this build does not know is dropped. The payload
/// is never logged: it holds no secret, but it names the person's work.
public func notificationPayload(from userInfo: [AnyHashable: Any]) -> NotificationPayload? {
  guard let value = userInfo[apnsPayloadKey] else { return nil }
  let data: Data
  if let text = value as? String {
    data = Data(text.utf8)
  } else if let dictionary = value as? [String: Any], JSONSerialization.isValidJSONObject(dictionary),
    let encoded = try? JSONSerialization.data(withJSONObject: dictionary)
  {
    data = encoded
  } else {
    return nil
  }
  guard let payload = try? ContractJSON.decode(NotificationPayload.self, from: data, path: apnsPayloadKey),
    !payload.serverId.isEmpty
  else { return nil }
  return payload
}
