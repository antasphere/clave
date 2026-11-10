import ClaveCore
import XCTest
@testable import Clave

/// The live stores' names come from the bundle identifier, so the Debug and Release installs
/// (com.clave.ios.dev, com.clave.ios) never share a Keychain service. The Debug install keeps the
/// service its items are already filed under.
final class StorageNamesTests: XCTestCase {
  /// The service of the Keychain store the live environment builds for `bundleIdentifier`. Only
  /// the environment is built: no Keychain item is read or written.
  @MainActor
  private func liveKeychainService(bundleIdentifier: String) throws -> String {
    let environment = AppEnvironment.live(.release, bundleIdentifier: bundleIdentifier)
    let store = try XCTUnwrap(environment.secureStore as? KeychainSecureStore, "the live store is not the Keychain's")
    return store.service
  }

  /// The live store itself follows the identifier, not only the names it is built from: a
  /// service written into `live` by hand would file a Release install's items under another name.
  @MainActor
  func testTheLiveStoreOfTheReleaseIdentifierIsFiledUnderTheReleaseService() throws {
    XCTAssertEqual(try liveKeychainService(bundleIdentifier: "com.clave.ios"), "com.clave.ios.credentials")
  }

  @MainActor
  func testTheLiveStoreOfTheDebugIdentifierIsFiledUnderTheDebugService() throws {
    XCTAssertEqual(try liveKeychainService(bundleIdentifier: "com.clave.ios.dev"), "com.clave.ios.dev.credentials")
  }

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
