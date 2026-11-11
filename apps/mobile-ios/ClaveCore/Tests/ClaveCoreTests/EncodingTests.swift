import CryptoKit
import XCTest
@testable import ClaveCore

final class Base64URLTests: XCTestCase {
  func testEncodesAsFoundationWithoutPaddingForEveryLength() throws {
    var generator = SystemRandomNumberGenerator()
    for length in 0..<40 {
      let bytes = (0..<length).map { _ in UInt8.random(in: 0...255, using: &generator) }
      let expected = Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
      XCTAssertEqual(Base64URL.encode(bytes), expected)
      XCTAssertEqual(try Base64URL.decode(Base64URL.encode(bytes)), Data(bytes))
    }
  }

  func testRefusesPaddingTheStandardAlphabetAndImpossibleLengths() {
    XCTAssertThrowsError(try Base64URL.decode("YQ==")) { XCTAssertEqual($0 as? Base64URLError, .invalidCharacter) }
    XCTAssertThrowsError(try Base64URL.decode("a+b/")) { XCTAssertEqual($0 as? Base64URLError, .invalidCharacter) }
    XCTAssertThrowsError(try Base64URL.decode("abcde")) { XCTAssertEqual($0 as? Base64URLError, .impossibleLength) }
    XCTAssertThrowsError(try Base64URL.decode("ab c"))
    XCTAssertEqual(try Base64URL.decode(""), Data())
  }
}

final class PKCETests: XCTestCase {
  func testVerifierIs43CharactersOfTheAlphabet() {
    let verifier = PKCE.makeVerifier()
    XCTAssertEqual(verifier.count, 43)
    XCTAssertNotNil(verifier.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
    XCTAssertNotEqual(PKCE.makeVerifier(), verifier)
    XCTAssertEqual(PKCE.randomValue().count, 22)
  }

  func testPinnedBytesGiveAPinnedVerifier() {
    struct Zeroes: RandomSource { func bytes(_ count: Int) -> [UInt8] { [UInt8](repeating: 0, count: count) } }
    XCTAssertEqual(PKCE.makeVerifier(using: Zeroes()), String(repeating: "A", count: 43))
    XCTAssertEqual(PKCE.randomValue(bytes: 3, using: Zeroes()), "AAAA")
  }

  func testRFC7636AppendixBVector() {
    XCTAssertEqual(
      PKCE.challenge(of: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  }
}

final class IssuerTests: XCTestCase {
  func testIsTheHubWhenNothingIsSet() {
    let hub = IssuerResolution.ok(IssuerConfig(origin: defaultIssuer, insecure: false))
    XCTAssertEqual(resolveIssuer(nil), hub)
    XCTAssertEqual(resolveIssuer(""), hub)
    XCTAssertEqual(resolveIssuer("  "), hub)
  }

  func testTakesAnHTTPSOriginAndTheLiteralLoopbackOverHTTP() {
    XCTAssertEqual(resolveIssuer("https://hub.example/"), .ok(IssuerConfig(origin: "https://hub.example", insecure: false)))
    XCTAssertEqual(resolveIssuer("https://HUB.example:443"), .ok(IssuerConfig(origin: "https://hub.example", insecure: false)))
    XCTAssertEqual(resolveIssuer("http://127.0.0.1:4321"), .ok(IssuerConfig(origin: "http://127.0.0.1:4321", insecure: true)))
  }

  func testRefusesEverythingElseAndNeverFallsBackToTheHub() {
    let cases: [(String, String)] = [
      ("not a URL", "nope"),
      ("not a bare origin", "https://hub.example/path"),
      ("not a bare origin", "https://hub.example/?x=1"),
      ("not a bare origin", "https://hub.example/#frag"),
      ("not a bare origin", "https://user:pw@hub.example"),
      ("plain http is only accepted for 127.0.0.1", "http://localhost:4321"),
      ("plain http is only accepted for 127.0.0.1", "http://192.168.1.10:8080"),
      ("plain http is only accepted for 127.0.0.1", "ftp://127.0.0.1"),
    ]
    for (reason, raw) in cases {
      XCTAssertEqual(resolveIssuer(raw), .refused(reason: reason), raw)
    }
  }
}

final class OwnerNamespaceTests: XCTestCase {
  private func hex(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  func testIsTheHashOfThePrototypesExactJSON() {
    let issuer = "https://account.antasphere.com"
    XCTAssertEqual(
      ownerNamespace(issuer: issuer, subject: "user-7f3a"),
      "clave.owner." + hex(#"["https://account.antasphere.com",{"subject":"user-7f3a"}]"#))
    XCTAssertEqual(ownerNamespace(issuer: issuer, subject: nil), "clave.owner." + hex(#"["https://account.antasphere.com",null]"#))
    // The figures Node's JSON.stringify and createHash give for the same inputs.
    XCTAssertEqual(
      ownerNamespace(issuer: issuer, subject: "user-7f3a"),
      "clave.owner.5a99a50e4c0f7465ca0b4353e5a306a56ea48ef60aa35501c41ccabb166bb23e")
    XCTAssertEqual(
      ownerNamespace(issuer: issuer, subject: nil),
      "clave.owner.456da0db3168b8b90f39041e8fd8f0394538b97fe17ee8f69b819cf79c392b6c")
    XCTAssertEqual(
      ownerNamespace(issuer: "https://hub.test", subject: "a\"b\\c\nd\u{01}é/日"),
      "clave.owner.692e02fd381797762d988d85e2a58d73fa73c27cbbc1aaf8e4a93818854b0790")
  }

  func testBindsIssuerAndSubject() {
    let keys: Set<String> = [
      ownerNamespace(issuer: "https://a.example", subject: "subject"),
      ownerNamespace(issuer: "https://b.example", subject: "subject"),
      ownerNamespace(issuer: "https://a.example", subject: "other"),
      ownerNamespace(issuer: "https://a.example", subject: nil),
      ownerNamespace(issuer: "https://a.example", subject: "signed-out"),
    ]
    XCTAssertEqual(keys.count, 5)
    XCTAssertTrue(keys.allSatisfy { $0.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil })
  }

  func testScopedStoresPrefixKeysSoTwoOwnersNeverShareOne() async throws {
    let secure = InMemorySecureStore()
    let kv = InMemoryKeyValueStore()
    let a = ownerNamespace(issuer: "https://a.example", subject: "a")
    let b = ownerNamespace(issuer: "https://a.example", subject: "b")
    let secureA = OwnerScopedSecureStore(base: secure, namespace: a)
    let secureB = OwnerScopedSecureStore(base: secure, namespace: b)
    let kvA = OwnerScopedKeyValueStore(base: kv, namespace: a)
    let kvB = OwnerScopedKeyValueStore(base: kv, namespace: b)
    try await secureA.set("credential", "bearer-a")
    try await kvA.set("machines", "[\"m\"]")
    let secureValue = try await secureB.get("credential")
    let kvValue = try await kvB.get("machines")
    XCTAssertNil(secureValue)
    XCTAssertNil(kvValue)
    let secureKeys = await secure.values.keys.sorted()
    let kvKeys = await kv.values.keys.sorted()
    XCTAssertEqual(secureKeys, ["\(a).credential"])
    XCTAssertEqual(kvKeys, ["\(a):machines"])
    // A late write through A's scope stays in A's namespace.
    try await secureA.set("credential", "late-a")
    let late = try await OwnerScopedSecureStore(base: secure, namespace: a).get("credential")
    XCTAssertEqual(late, "late-a")
    try await secureA.delete("credential")
    try await kvA.remove("machines")
    let emptied = await secure.values.isEmpty
    XCTAssertTrue(emptied)
  }

  func testFileKeyValueStorePersistsAcrossInstances() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("clave-kv-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = FileKeyValueStore(directory: directory)
    try await first.set("a", "1")
    try await first.set("b", "2")
    try await first.remove("a")
    let second = FileKeyValueStore(directory: directory)
    let a = try await second.get("a")
    let b = try await second.get("b")
    XCTAssertNil(a)
    XCTAssertEqual(b, "2")
  }
}
