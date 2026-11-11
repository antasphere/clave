import XCTest
@testable import ClaveCore

final class ClaveCoreInfoTests: XCTestCase {
  func testVersionIsSemver() {
    XCTAssertTrue(ClaveCoreInfo.version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil)
  }
}
