import Foundation

/// Why a pairing call did not answer what was asked.
public struct EnrollmentError: Error, Sendable, Equatable, CustomStringConvertible {
  public enum Kind: Sendable, Equatable {
    /// The request never completed.
    case network
    /// The deadline passed.
    case timeout
    /// The machine answered something this client does not read.
    case `protocol`
    /// The machine refused the ID token by one of its checks, named here.
    case refused(check: String)
    /// The machine has no Antasphere login: nobody owns it, so it admits no phone.
    case unavailable
    /// The approval was already handed out to an earlier read.
    case consumed
    /// The machine refused the call outright (403).
    case forbidden
  }

  public let kind: Kind
  public let message: String

  public init(_ kind: Kind, _ message: String) {
    self.kind = kind
    self.message = message
  }

  public var description: String { message }

  /// The name of the check that refused the token, on a refusal.
  public var check: String? {
    if case .refused(let check) = kind { return check }
    return nil
  }
}

/// The pairing routes a pairing needs, so a test can stand in for the machine.
public protocol PairingRoutes: Sendable {
  /// `POST /devices/pair`.
  func requestPairing(_ input: PairingRequestInput) async throws -> PairingTicket
  /// `GET /devices/pair?id=`.
  func readPairing(_ pairingId: String) async throws -> PairingRead
}

/// The pairing routes of one machine. `POST /devices/pair` takes no bearer:
/// the proof is in the body (the hub's ID token for the phone's own client,
/// and how the phone names itself). `GET /devices/pair?id=` says where the
/// pairing stands and carries the device session exactly once on `approved`.
public struct EnrollmentClient: PairingRoutes {
  /// The server's bound on a pairing request.
  public static let maxRequestBytes = 16 * 1024

  /// The machine's road, without a trailing slash.
  public let baseURL: String
  private let transport: any HTTPTransport
  private let timeout: TimeInterval

  /// A client of the machine at `baseURL`; throws `TransportPolicyError` on an
  /// address this build sends no credential to (the ID token is one).
  public init(baseURL: String, transport: any HTTPTransport, build: BuildKind = .release, timeout: TimeInterval = 10) throws {
    var base = baseURL
    while base.hasSuffix("/") { base.removeLast() }
    try assertCredentialMayTravelTo(base, build: build)
    self.baseURL = base
    self.transport = transport
    self.timeout = timeout
  }

  public func requestPairing(_ input: PairingRequestInput) async throws -> PairingTicket {
    let body = try ContractJSON.encode(input)
    guard body.count <= Self.maxRequestBytes else {
      throw EnrollmentError(.protocol, "The pairing request is larger than the machine accepts.")
    }
    return try decode(PairingTicket.self, try await send("POST", "/devices/pair", body: body))
  }

  public func readPairing(_ pairingId: String) async throws -> PairingRead {
    let query = WebURL.formEncode([("id", pairingId)])
    return try decode(PairingRead.self, try await send("GET", "/devices/pair?\(query)", body: nil))
  }

  private func decode<T: Decodable>(_ type: T.Type, _ body: Data) throws -> T {
    do {
      return try ContractJSON.decode(type, from: body)
    } catch {
      throw EnrollmentError(.protocol, "The pairing answer is unreadable: \(error)")
    }
  }

  private func send(_ method: String, _ target: String, body: Data?) async throws -> Data {
    guard let url = URL(string: baseURL + target) else {
      throw EnrollmentError(.protocol, "The machine's address is not readable.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = timeout
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body
    }
    let answer: HTTPAnswer
    do {
      answer = try await transport.perform(request)
    } catch let error as URLError where error.code == .timedOut {
      throw EnrollmentError(.timeout, "The machine did not answer within \(Int(timeout)) s.")
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw EnrollmentError(.network, "The machine could not be reached.")
    }
    let status = answer.status
    if (200..<300).contains(status) { return answer.body }
    if status == 403 { throw EnrollmentError(.forbidden, "The machine refused this call.") }
    if status == 422 { throw Self.refusal(answer.body) }
    throw EnrollmentError(.protocol, "The machine answered \(status).")
  }

  /// A declared failure, by its tag: the server names the check that refused the token, never the token.
  static func refusal(_ body: Data) -> EnrollmentError {
    guard let failure = try? ContractJSON.decode(ServerFailure.self, from: body) else {
      return EnrollmentError(.protocol, "The machine refused (422) without a readable reason.")
    }
    switch failure.tag {
    case "DevicePairingRefused":
      let check = failure.check ?? "unknown"
      return EnrollmentError(.refused(check: check), failure.message)
    case "CapabilityUnavailable":
      return EnrollmentError(.unavailable, "This machine has no Antasphere login. Sign in on it first, then pair.")
    default:
      return EnrollmentError(.protocol, failure.message)
    }
  }
}
