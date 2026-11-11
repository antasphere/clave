import Foundation

/// A refusal the server declared, as a 422 carries it: the tag names the
/// failure, the message is the sentence to show, and the fields the phone
/// reads beside them (`capability` on CapabilityUnavailable, `check` on
/// DevicePairingRefused, `code` on RequestRejected or FileOperationFailed,
/// `id` on a SessionNotFound). Anything else in the body is left where it is.
public struct ServerFailure: Sendable, Equatable, Decodable {
  public let tag: String
  public let message: String
  public let capability: String?
  public let code: String?
  public let id: String?
  public let check: String?

  public init(tag: String, message: String, capability: String? = nil, code: String? = nil, id: String? = nil, check: String? = nil) {
    self.tag = tag
    self.message = message
    self.capability = capability
    self.code = code
    self.id = id
    self.check = check
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    tag = try c.decodeNonEmpty("_tag")
    message = try c.decodeOptionalString("message") ?? "The server refused (\(tag))."
    capability = try c.decodeOptionalString("capability")
    code = try c.decodeOptionalString("code")
    id = try c.decodeOptionalString("id")
    check = try c.decodeOptionalString("check")
  }
}
