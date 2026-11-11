// swift-tools-version: 6.2
// ClaveCore: the phone's logic apart from its screens, Foundation only, so it
// builds and tests on the Mac (`swift test`) and on the simulator alike.
import PackageDescription

let package = Package(
  name: "ClaveCore",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "ClaveCore", targets: ["ClaveCore"])],
  targets: [
    .target(name: "ClaveCore"),
    .testTarget(
      name: "ClaveCoreTests",
      dependencies: ["ClaveCore"],
      resources: [.copy("Fixtures")]
    )
  ],
  swiftLanguageModes: [.v6]
)
