import Foundation

// What the sign-in keeps on the phone, in the secure store: the client the
// app registered at the hub (its id and the issuer it belongs to, nothing
// secret, kept beside the tokens for one store rather than two), the person,
// and the three tokens, each under its own key so no one Keychain item grows
// with the ID token's profile claims. The JSON shapes are the prototype's
// (`store.ts`); the reads are as lenient as its were, and an item that no
// longer parses reads as absent. Nothing here is ever logged.

/// The keys the sign-in files its items under.
public enum HubStoreKey {
  public static let client = "hub.client"
  public static let session = "hub.session"
  public static let accessToken = "hub.access"
  public static let idToken = "hub.id"
  public static let refreshToken = "hub.refresh"
}

/// The registration the app holds at one issuer.
public struct StoredClient: Sendable, Equatable {
  public let issuer: String
  public let clientId: String
  /// Epoch milliseconds.
  public let registeredAt: Double

  /// A registration record.
  public init(issuer: String, clientId: String, registeredAt: Double) {
    self.issuer = issuer
    self.clientId = clientId
    self.registeredAt = registeredAt
  }
}

/// The person signed in.
public struct StoredAccount: Sendable, Equatable {
  public let subject: String
  public let name: String?
  public let email: String?
  public let emailVerified: Bool

  /// A person record.
  public init(subject: String, name: String?, email: String?, emailVerified: Bool) {
    self.subject = subject
    self.name = name
    self.email = email
    self.emailVerified = emailVerified
  }
}

/// The session: who, through which client of which issuer, since when.
public struct StoredSession: Sendable, Equatable {
  public let issuer: String
  public let clientId: String
  public let account: StoredAccount
  /// Epoch milliseconds.
  public let signedInAt: Double

  /// A session record.
  public init(issuer: String, clientId: String, account: StoredAccount, signedInAt: Double) {
    self.issuer = issuer
    self.clientId = clientId
    self.account = account
    self.signedInAt = signedInAt
  }
}

/// A token and when it ends.
public struct StoredToken: Sendable, Equatable {
  public let token: String
  /// Epoch milliseconds: the ID token's `exp`, the access token's `expires_in` from its arrival.
  public let expiresAt: Double

  /// A token record.
  public init(token: String, expiresAt: Double) {
    self.token = token
    self.expiresAt = expiresAt
  }
}

/// The sign-in's records over a secure store.
public struct HubTokenStore: Sendable {
  private let secure: any SecureStore

  /// The records kept in `secure`.
  public init(secure: any SecureStore) {
    self.secure = secure
  }

  private func readJSON<T>(_ key: String, _ read: (JSONValue) -> T?) async throws -> T? {
    guard let raw = try await secure.get(key), !raw.isEmpty, let json = JSONValue.parse(raw) else { return nil }
    return read(json)
  }

  /// The stored registration, if any.
  public func readClient() async throws -> StoredClient? {
    try await readJSON(HubStoreKey.client) { json in
      guard json.isObject, let issuer = json["issuer"]?.stringValue,
        let clientId = json["clientId"]?.stringValue, !clientId.isEmpty
      else { return nil }
      return StoredClient(issuer: issuer, clientId: clientId, registeredAt: json["registeredAt"]?.numberValue ?? 0)
    }
  }

  /// Keeps the registration.
  public func writeClient(_ client: StoredClient) async throws {
    let json = JSONValue.object([
      "issuer": .string(client.issuer), "clientId": .string(client.clientId),
      "registeredAt": .number(client.registeredAt),
    ])
    try await secure.set(HubStoreKey.client, json.serialized())
  }

  /// Forgets the registration.
  public func clearClient() async throws {
    try await secure.delete(HubStoreKey.client)
  }

  /// The stored session, if any.
  public func readSession() async throws -> StoredSession? {
    try await readJSON(HubStoreKey.session) { json in
      guard json.isObject, let account = json["account"], account.isObject,
        let issuer = json["issuer"]?.stringValue, let clientId = json["clientId"]?.stringValue,
        let subject = account["subject"]?.stringValue, !subject.isEmpty
      else { return nil }
      return StoredSession(
        issuer: issuer, clientId: clientId,
        account: StoredAccount(
          subject: subject, name: account["name"]?.stringValue, email: account["email"]?.stringValue,
          emailVerified: account["emailVerified"]?.boolValue == true),
        signedInAt: json["signedInAt"]?.numberValue ?? 0)
    }
  }

  /// Keeps the session.
  public func writeSession(_ session: StoredSession) async throws {
    let account = session.account
    let json = JSONValue.object([
      "issuer": .string(session.issuer),
      "clientId": .string(session.clientId),
      "account": .object([
        "subject": .string(account.subject),
        "name": account.name.map(JSONValue.string) ?? .null,
        "email": account.email.map(JSONValue.string) ?? .null,
        "emailVerified": .bool(account.emailVerified),
      ]),
      "signedInAt": .number(session.signedInAt),
    ])
    try await secure.set(HubStoreKey.session, json.serialized())
  }

  /// The refresh token, kept as the bare string.
  public func readRefreshToken() async throws -> String? {
    guard let raw = try await secure.get(HubStoreKey.refreshToken), !raw.isEmpty else { return nil }
    return raw
  }

  /// Keeps the refresh token.
  public func writeRefreshToken(_ token: String) async throws {
    try await secure.set(HubStoreKey.refreshToken, token)
  }

  /// The access token, if any.
  public func readAccessToken() async throws -> StoredToken? {
    try await readJSON(HubStoreKey.accessToken, Self.readToken)
  }

  /// Keeps the access token.
  public func writeAccessToken(_ token: StoredToken) async throws {
    try await secure.set(HubStoreKey.accessToken, Self.serialize(token))
  }

  /// The ID token, if any.
  public func readIdToken() async throws -> StoredToken? {
    try await readJSON(HubStoreKey.idToken, Self.readToken)
  }

  /// Keeps the ID token.
  public func writeIdToken(_ token: StoredToken) async throws {
    try await secure.set(HubStoreKey.idToken, Self.serialize(token))
  }

  /// The person and every token go; the client registration stays.
  public func clearSession() async throws {
    for key in [HubStoreKey.session, HubStoreKey.refreshToken, HubStoreKey.accessToken, HubStoreKey.idToken] {
      try await secure.delete(key)
    }
  }

  private static func readToken(_ json: JSONValue) -> StoredToken? {
    guard json.isObject, let token = json["token"]?.stringValue, !token.isEmpty,
      let expiresAt = json["expiresAt"]?.numberValue, expiresAt.isFinite
    else { return nil }
    return StoredToken(token: token, expiresAt: expiresAt)
  }

  private static func serialize(_ token: StoredToken) -> String {
    JSONValue.object(["token": .string(token.token), "expiresAt": .number(token.expiresAt)]).serialized()
  }
}
