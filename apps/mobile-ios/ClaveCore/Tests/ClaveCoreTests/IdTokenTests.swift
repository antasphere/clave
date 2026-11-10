import XCTest
@testable import ClaveCore

final class IdTokenTests: XCTestCase {
  private let claims: [String: JSValue] = [
    "iss": .string("https://hub.test"), "sub": .string("user-1"), "aud": .string("client-1"),
    "exp": .number(2_000_000_000), "iat": .number(1_900_000_000), "nonce": .string("n-1"),
    "name": .string("Ada"), "email": .string("ada@example.test"), "email_verified": .bool(true),
  ]
  private let rs256: [String: JSValue] = ["alg": .string("RS256"), "typ": .string("JWT")]

  private func token(_ header: [String: JSValue]? = nil, _ changes: [String: JSValue] = [:]) -> String {
    makeIdToken(header: header ?? rs256, payload: claims.merging(changes) { _, new in new })
  }

  private func segment(_ value: JSValue) -> String { Base64URL.encode(Data(value.serialized().utf8)) }

  private func refusal(_ run: () throws -> Void) -> IdTokenRefusal? {
    do {
      try run()
      return nil
    } catch {
      return (error as? IdTokenRefused)?.check
    }
  }

  func testReadsTheClaimsOfAWellFormedToken() throws {
    XCTAssertEqual(
      try decodeIdToken(token()),
      IdTokenClaims(
        iss: "https://hub.test", sub: "user-1", aud: ["client-1"], exp: 2_000_000_000, iat: 1_900_000_000,
        nonce: "n-1", azp: nil, name: "Ada", email: "ada@example.test", emailVerified: true))
  }

  func testAcceptsRS256AndES256HeadersAndAnAudienceList() throws {
    XCTAssertEqual(try decodeIdToken(token(["alg": .string("ES256")])).sub, "user-1")
    XCTAssertEqual(try decodeIdToken(token(["alg": .string("RS256")])).sub, "user-1")
    XCTAssertEqual(
      try decodeIdToken(token(nil, ["aud": .array([.string("a"), .string("client-1")])])).aud, ["a", "client-1"])
  }

  func testRefusesByShape() {
    let header = segment(.object(["alg": .string("RS256")]))
    let payload = segment(.object(claims))
    let sig = Base64URL.encode([1, 2, 3, 4])
    let cases: [(String, String, IdTokenRefusal)] = [
      ("two segments", "\(header).\(payload)", .format),
      ("an empty signature", "\(header).\(payload).", .format),
      ("a signature outside the alphabet", "\(header).\(payload).a+b/", .format),
      ("a header that is not JSON", "abc.\(payload).\(sig)", .format),
      ("a payload with padding", "\(header).\(payload)=.\(sig)", .format),
      ("alg none", token(["alg": .string("none")]), .algorithm),
      ("alg HS256", token(["alg": .string("HS256"), "typ": .string("JWT")]), .algorithm),
      ("no alg", token(["typ": .string("JWT")]), .algorithm),
      ("a typ that is not JWT", token(["alg": .string("RS256"), "typ": .string("JWE")]), .format),
      ("no issuer", token(nil, ["iss": .string("")]), .format),
      ("no subject", token(nil, ["sub": .string("")]), .subject),
      ("a numeric subject", token(nil, ["sub": .number(7)]), .subject),
      ("an empty audience", token(nil, ["aud": .array([])]), .format),
      ("a mixed audience", token(nil, ["aud": .array([.string("a"), .number(1)])]), .format),
      ("no expiry", token(nil, ["exp": .string("soon")]), .format),
      ("a boolean issued-at", token(nil, ["iat": .bool(true)]), .format),
      ("a non-boolean email_verified", token(nil, ["email_verified": .string("yes")]), .format),
      ("a numeric email_verified", token(nil, ["email_verified": .number(1)]), .format),
      ("a null nonce", token(nil, ["nonce": .null]), .format),
    ]
    for (name, value, check) in cases {
      XCTAssertEqual(refusal { _ = try decodeIdToken(value) }, check, name)
    }
  }

  private var expected: ExpectedIdToken {
    ExpectedIdToken(
      issuer: "https://hub.test", clientId: "client-1", nonce: "n-1", now: Date(timeIntervalSince1970: 1_950_000_000))
  }

  func testPassesTheTokenThePhoneAskedForAndARefreshWithoutNonce() throws {
    let decoded = try decodeIdToken(token())
    XCTAssertNoThrow(try checkIdToken(decoded, expected: expected))
    let withoutNonce = try decodeIdToken(token(nil, ["nonce": .string("other")]))
    XCTAssertNoThrow(
      try checkIdToken(withoutNonce, expected: ExpectedIdToken(issuer: expected.issuer, clientId: expected.clientId, now: expected.now)))
  }

  func testRefusesEachCheckByName() throws {
    let decoded = try decodeIdToken(token())
    func at(_ issuer: String = "https://hub.test", _ client: String = "client-1", nonce: String? = "n-1", now: TimeInterval = 1_950_000_000) -> ExpectedIdToken {
      ExpectedIdToken(issuer: issuer, clientId: client, nonce: nonce, now: Date(timeIntervalSince1970: now))
    }
    XCTAssertEqual(refusal { try checkIdToken(decoded, expected: at("https://other.test")) }, .issuer)
    XCTAssertEqual(refusal { try checkIdToken(decoded, expected: at("https://hub.test", "client-2")) }, .audience)
    XCTAssertEqual(refusal { try checkIdToken(decoded, expected: at(nonce: "n-2")) }, .nonce)
    XCTAssertEqual(refusal { try checkIdToken(decoded, expected: at(now: 2_000_000_060)) }, .expired)
    XCTAssertEqual(refusal { try checkIdToken(decoded, expected: at(now: 2_000_000_100)) }, .expired)
    XCTAssertEqual(refusal { try checkIdToken(decoded, expected: at(now: 1_899_999_000)) }, .notYetValid)
    let withAzp = try decodeIdToken(token(nil, ["azp": .string("client-9")]))
    XCTAssertEqual(refusal { try checkIdToken(withAzp, expected: at()) }, .authorizedParty)
  }

  func testToleratesAMinuteOfClockSkew() throws {
    let decoded = try decodeIdToken(token())
    func at(_ now: TimeInterval) -> ExpectedIdToken {
      ExpectedIdToken(issuer: "https://hub.test", clientId: "client-1", nonce: "n-1", now: Date(timeIntervalSince1970: now))
    }
    XCTAssertNoThrow(try checkIdToken(decoded, expected: at(2_000_000_030)))
    XCTAssertNoThrow(try checkIdToken(decoded, expected: at(1_899_999_970)))
  }

  /// The issued-at check allows the skew and not a second more; the boundary is the skew the
  /// checks themselves carry, the server's minute.
  func testATokenIssuedASecondPastTheSkewAheadIsNotYetValid() throws {
    let now: TimeInterval = 1_950_000_000
    let expected = ExpectedIdToken(issuer: "https://hub.test", clientId: "client-1", nonce: "n-1", now: Date(timeIntervalSince1970: now))
    let skew = expected.skew
    XCTAssertEqual(skew, 60)
    func issued(_ ahead: TimeInterval) throws -> IdTokenClaims {
      try decodeIdToken(token(nil, ["iat": .number(now + ahead)]))
    }
    XCTAssertEqual(refusal { try checkIdToken(issued(skew + 1), expected: expected) }, .notYetValid)
    XCTAssertNoThrow(try checkIdToken(issued(skew - 1), expected: expected))
  }
}
