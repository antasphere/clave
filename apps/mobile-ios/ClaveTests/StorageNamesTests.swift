import XCTest
@testable import Clave

/// The live stores' names come from the bundle identifier, so the Debug and Release installs
/// (com.clave.ios.dev, com.clave.ios) never share a Keychain service. The Debug install keeps the
/// service its items are already filed under.
final class StorageNamesTests: XCTestCase {
  func testTwoBundleIdentifiersGiveTwoKeychainServices() {
    let debug = AppEnvironment.storageNames(bundleIdentifier: "com.clave.ios.dev")
    let release = AppEnvironment.storageNames(bundleIdentifier: "com.clave.ios")
    XCTAssertEqual(debug.keychainService, "com.clave.ios.dev.credentials")
    XCTAssertEqual(release.keychainService, "com.clave.ios.credentials")
    XCTAssertNotEqual(debug.keychainService, release.keychainService)
  }

  func testABundleWithNoIdentifierIsTakenForTheDevelopmentBuild() {
    XCTAssertEqual(AppEnvironment.storageNames(bundleIdentifier: nil), AppEnvironment.storageNames(bundleIdentifier: "com.clave.ios.dev"))
  }

  /// The host the tests run in is the Debug app.
  func testTheTestHostIsTheDebugBuild() {
    XCTAssertEqual(Bundle.main.bundleIdentifier, "com.clave.ios.dev")
    XCTAssertEqual(AppEnvironment.storageNames(bundleIdentifier: Bundle.main.bundleIdentifier).keychainService, "com.clave.ios.dev.credentials")
  }
}
