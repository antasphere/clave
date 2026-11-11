import Foundation

/// The machines of the person, from the relay: `GET <relay>/machines` with
/// the hub's access token answers the subject's machines; each one is
/// reached at `<relay>/m/<id>` and its socket at `<relay>/m/<id>/push`.
public struct RelayMachineSource: MachineSource {
  /// The relay's origin, without a trailing slash.
  public let relayURL: String
  private let token: @Sendable () async throws -> String
  private let transport: any HTTPTransport
  private let timeout: TimeInterval

  /// A source over the relay at `relayURL`; throws `TransportPolicyError` on
  /// an address this build sends no credential to.
  public init(
    relayURL: String,
    token: @escaping @Sendable () async throws -> String,
    transport: any HTTPTransport,
    build: BuildKind = .release,
    timeout: TimeInterval = 10
  ) throws {
    var base = relayURL
    while base.hasSuffix("/") { base.removeLast() }
    try assertCredentialMayTravelTo(base, build: build)
    self.relayURL = base
    self.token = token
    self.transport = transport
    self.timeout = timeout
  }

  public func list() async throws -> [Machine] {
    guard let url = URL(string: relayURL + relayMachinesPath) else {
      throw ServerError(.protocol, "The relay address is not readable.")
    }
    let bearer = try await token()
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = timeout
    request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let answer: HTTPAnswer
    do {
      answer = try await transport.perform(request)
    } catch let error as URLError where error.code == .timedOut {
      throw ServerError(.timeout, "The relay did not answer in time.")
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw ServerError(.network, "The relay could not be reached.")
    }
    if answer.status == 401 {
      throw ServerError(.unauthenticated, "The relay refused the sign-in.", status: 401)
    }
    guard (200..<300).contains(answer.status) else {
      throw ServerError(.protocol, "The relay answered \(answer.status).", status: answer.status)
    }
    let list: MachineList
    do {
      list = try ContractJSON.decode(MachineList.self, from: answer.body)
    } catch {
      throw ServerError(.protocol, "The relay answered no readable machine list: \(error)", status: answer.status)
    }
    // The direct addresses a row carries are not used: the relay is the road (decision 4).
    return list.machines.map { view in
      Machine(
        id: view.id, name: view.name, platform: view.platform, version: view.version, online: view.online,
        lastSeen: view.lastSeen, baseUrl: machineBaseURL(relay: relayURL, machineId: view.id),
        pushUrl: machinePushURL(relay: relayURL, machineId: view.id))
    }
  }
}
