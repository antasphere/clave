import XCTest
@testable import ClaveCore

/// (d) Where a credential may travel: transport-policy.test.ts.
final class TransportPolicyTests: XCTestCase {
  func testHttpsAndWssAlways() {
    for build in BuildKind.allCases {
      XCTAssertEqual(credentialMayTravelTo("https://relay.example/m/a", build: build), .allowed)
      XCTAssertEqual(credentialMayTravelTo("wss://relay.example/m/a/push", build: build), .allowed)
      XCTAssertEqual(credentialMayTravelTo("https://192.168.1.20:43201", build: build), .allowed)
    }
  }

  func testAReleaseBuildRefusesHttpAndWsEvenToTheLoopback() {
    for url in ["http://127.0.0.1:43201", "ws://127.0.0.1:43201/push", "http://localhost:1", "ws://[::1]:2/push", "http://192.168.1.20"] {
      guard case .refused(let reason) = credentialMayTravelTo(url, build: .release) else { return XCTFail(url) }
      XCTAssertTrue(reason.contains("never travels over plain"), reason)
    }
  }

  func testADevelopmentBuildAcceptsPlainTransportsToTheLoopbackOnly() {
    for url in ["http://127.0.0.1:43201", "ws://127.0.0.1:43201/push", "http://localhost:43201", "http://LOCALHOST", "ws://[::1]:43201/push", "http://[::1]"] {
      XCTAssertEqual(credentialMayTravelTo(url, build: .development), .allowed, url)
    }
    for url in ["http://192.168.1.20:43201", "ws://10.0.0.2/push", "http://127.0.0.2", "http://localhost.example", "http://[::2]"] {
      guard case .refused(let reason) = credentialMayTravelTo(url, build: .development) else { return XCTFail(url) }
      XCTAssertTrue(reason.contains("development build"), reason)
    }
  }

  func testAnythingElseNever() {
    XCTAssertFalse(credentialMayTravelTo("ftp://relay.example", build: .development).isAllowed)
    XCTAssertFalse(credentialMayTravelTo("not a url", build: .development).isAllowed)
    XCTAssertFalse(credentialMayTravelTo("http:foo", build: .development).isAllowed)
    XCTAssertFalse(credentialMayTravelTo("", build: .development).isAllowed)
  }

  func testTheLoopbackNames() {
    XCTAssertTrue(isLoopbackHost("127.0.0.1"))
    XCTAssertTrue(isLoopbackHost("LocalHost"))
    XCTAssertTrue(isLoopbackHost("[::1]"))
    XCTAssertTrue(isLoopbackHost("::1"))
    XCTAssertFalse(isLoopbackHost("127.0.0.2"))
  }

  func testTheAssertThrowsThePolicyError() {
    XCTAssertThrowsError(try assertCredentialMayTravelTo("http://10.0.0.2", build: .release)) {
      XCTAssertEqual(($0 as? TransportPolicyError)?.url, "http://10.0.0.2")
    }
    XCTAssertNoThrow(try assertCredentialMayTravelTo("https://10.0.0.2", build: .release))
  }

  func testAReleasePushClientRefusesAPlainWsAddressBeforeOpeningASocket() async {
    let server = FakePushServer()
    XCTAssertThrowsError(try PushClient(url: "ws://192.168.1.20:43201/push", bearer: { "t" }, transport: server))
    XCTAssertThrowsError(try PushClient(url: "http://127.0.0.1:43201", bearer: { "t" }, transport: server))
    XCTAssertNoThrow(try PushClient(url: "http://127.0.0.1:43201", bearer: { "t" }, transport: server, build: .development))
    XCTAssertEqual(server.connections.count, 0)
  }
}
