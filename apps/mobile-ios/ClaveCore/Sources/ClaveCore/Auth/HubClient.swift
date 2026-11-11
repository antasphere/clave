import Foundation

// The phone's client of the hub's OAuth surface, over HTTPTransport:
// discovery, the dynamic registration of the app as an anonymous public
// native client, the authorization URL, the code exchange and the refresh
// grant. Every request is pinned to the issuer's origin and waits at most
// 15 s, the Mac's two bounds. The registration is the Mac's with the phone's
// redirect: `type: native` (the hub's own field) beside `application_type:
// native` (RFC 7591, what the local provider echoes); a registration that
// comes back confidential or without the code grant is refused and nothing
// is kept. The hub answers 200 where RFC 7591 says 201: both are a
// registration.

/// A hub call that failed, by kind; the message never carries a server's text.
public struct HubError: Error, Equatable, CustomStringConvertible {
  /// What went wrong.
  public enum Kind: String, Sendable, Equatable {
    case network
    case timeout
    case invalidResponse = "invalid-response"
    case registration
    case invalidGrant = "invalid_grant"
    case invalidClient = "invalid_client"
  }

  public let kind: Kind
  public let message: String
  public let status: Int?

  /// A failure of one kind.
  public init(kind: Kind, message: String, status: Int? = nil) {
    self.kind = kind
    self.message = message
    self.status = status
  }

  public var description: String { message }
}

/// The endpoints the discovery document names, each on the issuer's origin.
public struct HubMetadata: Sendable, Equatable {
  public let issuer: String
  public let authorizationEndpoint: String
  public let tokenEndpoint: String
  public let registrationEndpoint: String?
  public let jwksUri: String
  public let userinfoEndpoint: String?
}

/// A token endpoint's answer.
public struct TokenResponse: Sendable, Equatable {
  public let accessToken: String
  public let tokenType: String
  /// Seconds, when the hub states one.
  public let expiresIn: Int?
  public let idToken: String?
  public let refreshToken: String?
  public let scope: String?
}

/// The hub's OAuth endpoints for one issuer.
public actor HubClient {
  /// The bound on every request, the Mac's.
  public static let requestTimeout: Duration = .seconds(15)

  public nonisolated let issuer: IssuerConfig
  private let transport: any HTTPTransport
  private let timeout: Duration
  private var metadataCache: HubMetadata?

  /// A client of `issuer` over `transport`.
  public init(issuer: IssuerConfig, transport: any HTTPTransport, timeout: Duration = HubClient.requestTimeout) {
    self.issuer = issuer
    self.transport = transport
    self.timeout = timeout
  }

  /// The discovery document, read once; every endpoint must sit on the
  /// issuer's origin or the metadata is refused before the browser is sent
  /// anywhere.
  public func metadata() async throws -> HubMetadata {
    if let metadataCache { return metadataCache }
    let (status, json) = try await request("GET", "\(issuer.origin)/.well-known/openid-configuration")
    guard status == 200, let json, json.isObject else {
      throw HubError(kind: .invalidResponse, message: "The issuer served no discovery document.", status: status)
    }
    guard json["issuer"]?.stringValue == issuer.origin else {
      throw HubError(kind: .invalidResponse, message: "The metadata names another issuer.")
    }
    func endpoint(_ key: String, required: Bool) throws -> String? {
      guard let value = json[key] else {
        if required { throw HubError(kind: .invalidResponse, message: "\(key) is missing.") }
        return nil
      }
      guard let text = value.stringValue, onIssuer(text) else {
        throw HubError(kind: .invalidResponse, message: "\(key) is off the issuer.")
      }
      return text
    }
    let metadata = HubMetadata(
      issuer: issuer.origin,
      authorizationEndpoint: try endpoint("authorization_endpoint", required: true)!,
      tokenEndpoint: try endpoint("token_endpoint", required: true)!,
      registrationEndpoint: try endpoint("registration_endpoint", required: false),
      jwksUri: try endpoint("jwks_uri", required: true)!,
      userinfoEndpoint: try endpoint("userinfo_endpoint", required: false)
    )
    // A concurrent caller may have filled the cache while this one waited:
    // the first document read stays the one every caller sees.
    if let metadataCache { return metadataCache }
    metadataCache = metadata
    return metadata
  }

  /// Registers the app; answers the client id.
  public func register() async throws -> String {
    let metadata = try await metadata()
    guard let endpoint = metadata.registrationEndpoint else {
      throw HubError(kind: .registration, message: "The issuer registers no clients.")
    }
    let body = JSValue.object([
      "client_name": .string(clientName),
      "type": .string("native"),
      "application_type": .string("native"),
      "redirect_uris": .array([.string(redirectURI)]),
      "token_endpoint_auth_method": .string("none"),
      "grant_types": .array([.string("authorization_code"), .string("refresh_token")]),
      "response_types": .array([.string("code")]),
      "scope": .string(hubScope),
    ]).serialized()
    let (status, json) = try await request("POST", endpoint, body: body, contentType: "application/json")
    guard status == 200 || status == 201 else {
      throw HubError(kind: .registration, message: "The issuer refused the registration.", status: status)
    }
    guard let json, json.isObject, let clientId = json["client_id"]?.stringValue, !clientId.isEmpty else {
      throw HubError(kind: .registration, message: "The registration answered no client id.", status: status)
    }
    if json["client_secret"] != nil
      || (json["token_endpoint_auth_method"] != nil && json["token_endpoint_auth_method"]?.stringValue != "none")
    {
      throw HubError(kind: .registration, message: "The issuer registered a confidential client.", status: status)
    }
    guard case .array(let grants)? = json["grant_types"], grants.contains(.string("authorization_code")) else {
      throw HubError(kind: .registration, message: "The registration lacks the code grant.", status: status)
    }
    return clientId
  }

  /// The authorization request for the authentication session to open.
  public func authorizationURL(clientId: String, codeChallenge: String, state: String, nonce: String) async throws -> URL {
    let metadata = try await metadata()
    guard var components = URLComponents(string: metadata.authorizationEndpoint) else {
      throw HubError(kind: .invalidResponse, message: "The authorization endpoint is not a URL.")
    }
    // As URLSearchParams.set does: an existing parameter of the same name is
    // replaced in place, the rest of the endpoint's query is kept.
    var pairs = WebURL.formDecode(components.percentEncodedQuery)
    for (name, value) in [
      ("response_type", "code"), ("client_id", clientId), ("redirect_uri", redirectURI),
      ("scope", hubScope), ("code_challenge", codeChallenge), ("code_challenge_method", "S256"),
      ("state", state), ("nonce", nonce),
    ] {
      if let first = pairs.firstIndex(where: { $0.0 == name }) {
        pairs[first].1 = value
        pairs = pairs.enumerated().filter { $0.offset == first || $0.element.0 != name }.map(\.element)
      } else {
        pairs.append((name, value))
      }
    }
    components.percentEncodedQuery = WebURL.formEncode(pairs)
    guard let url = components.url else {
      throw HubError(kind: .invalidResponse, message: "The authorization endpoint is not a URL.")
    }
    return url
  }

  /// Exchanges an authorization code with its PKCE verifier.
  public func exchangeCode(clientId: String, code: String, verifier: String) async throws -> TokenResponse {
    try await tokenRequest([
      ("grant_type", "authorization_code"), ("client_id", clientId), ("code", code),
      ("redirect_uri", redirectURI), ("code_verifier", verifier),
    ])
  }

  /// Presents a refresh token; the hub answers a rotated one.
  public func refresh(clientId: String, refreshToken: String) async throws -> TokenResponse {
    try await tokenRequest([
      ("grant_type", "refresh_token"), ("client_id", clientId), ("refresh_token", refreshToken),
    ])
  }

  private func tokenRequest(_ form: [(String, String)]) async throws -> TokenResponse {
    let metadata = try await metadata()
    let (status, json) = try await request(
      "POST", metadata.tokenEndpoint, body: WebURL.formEncode(form),
      contentType: "application/x-www-form-urlencoded")
    guard (200..<300).contains(status) else {
      let error = json?["error"]?.stringValue ?? ""
      if error == "invalid_grant" {
        throw HubError(kind: .invalidGrant, message: "The issuer refused the grant.", status: status)
      }
      if error == "invalid_client" {
        throw HubError(kind: .invalidClient, message: "The issuer no longer knows this client.", status: status)
      }
      throw HubError(
        kind: .invalidResponse,
        message: "The token endpoint answered \(status)\(error.isEmpty ? "" : " (\(error))").", status: status)
    }
    guard let json, json.isObject, let accessToken = json["access_token"]?.stringValue, !accessToken.isEmpty else {
      throw HubError(kind: .invalidResponse, message: "The token endpoint answered no access token.", status: status)
    }
    func optional(_ key: String) -> String? {
      guard let text = json[key]?.stringValue, !text.isEmpty else { return nil }
      return text
    }
    var expiresIn: Int?
    if let seconds = json["expires_in"]?.numberValue, seconds.isFinite, abs(seconds) < 1e12 {
      expiresIn = Int(seconds)
    }
    return TokenResponse(
      accessToken: accessToken,
      tokenType: json["token_type"]?.stringValue ?? "Bearer",
      expiresIn: expiresIn,
      idToken: optional("id_token"),
      refreshToken: optional("refresh_token"),
      scope: optional("scope")
    )
  }

  private nonisolated func onIssuer(_ url: String) -> Bool {
    WebURL.origin(of: url) == issuer.origin
  }

  private func request(
    _ method: String, _ urlString: String, body: String? = nil, contentType: String? = nil
  ) async throws -> (Int, JSValue?) {
    guard onIssuer(urlString), let url = URL(string: urlString) else {
      throw HubError(kind: .invalidResponse, message: "A request would leave the issuer.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
    if let body { request.httpBody = Data(body.utf8) }
    request.timeoutInterval = Double(timeout.components.seconds) + Double(timeout.components.attoseconds) / 1e18
    let answer = try await send(request)
    return (answer.status, JSValue.parse(answer.body))
  }

  /// One request under a whole-exchange deadline: URLSession's
  /// `timeoutInterval` is an idle bound, the prototype's was a total one.
  private func send(_ request: URLRequest) async throws -> HTTPAnswer {
    let transport = self.transport
    let timeout = self.timeout
    let deadlineMessage = "The issuer did not answer within \(timeout.components.seconds) s."
    do {
      return try await withThrowingTaskGroup(of: HTTPAnswer?.self) { group in
        group.addTask { try await transport.perform(request) }
        group.addTask {
          try await Task.sleep(for: timeout)
          return nil
        }
        defer { group.cancelAll() }
        guard let first = try await group.next(), let answer = first else {
          throw HubError(kind: .timeout, message: deadlineMessage)
        }
        return answer
      }
    } catch let error as HubError {
      throw error
    } catch let error as URLError where error.code == .timedOut {
      throw HubError(kind: .timeout, message: deadlineMessage)
    } catch {
      throw HubError(kind: .network, message: "The issuer could not be reached.")
    }
  }
}
