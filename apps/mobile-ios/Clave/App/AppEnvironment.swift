import ClaveCore
import Foundation

/// What the launch asked for, before anything is built from it. A release
/// build has exactly one value, `.release`: the overrides and the UI-test fake
/// are read under `#if DEBUG` only, so their names never reach that binary.
nonisolated struct LaunchOptions: Equatable, Sendable {
  var buildKind: BuildKind
  /// An issuer to sign in at instead of the hub, as the launch named it.
  var issuerOverride: String?
  /// A relay that wins over the one the person entered.
  var relayOverride: String?
  /// The in-process fake answers every call: no socket, no browser.
  var usesUITestFake: Bool

  static let release = LaunchOptions(buildKind: .release, issuerOverride: nil, relayOverride: nil, usesUITestFake: false)

  #if DEBUG
    static let uiTestFakeArgument = "--ui-test-fake"
    static let issuerVariable = "CLAVE_IOS_ISSUER"
    static let relayVariable = "CLAVE_IOS_RELAY"

    /// The options a launch with this environment and these arguments gets.
    /// `isDebug: false` is how a test proves a release-like build reads none of it.
    static func resolve(isDebug: Bool, environment: [String: String], arguments: [String]) -> LaunchOptions {
      guard isDebug else { return .release }
      func value(_ name: String) -> String? {
        guard let raw = environment[name]?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        return raw
      }
      return LaunchOptions(
        buildKind: .development,
        issuerOverride: value(issuerVariable),
        relayOverride: value(relayVariable),
        usesUITestFake: arguments.contains(uiTestFakeArgument))
    }
  #endif

  /// The options of this process.
  static func current() -> LaunchOptions {
    #if DEBUG
      resolve(isDebug: true, environment: ProcessInfo.processInfo.environment, arguments: CommandLine.arguments)
    #else
      .release
    #endif
  }
}

/// Everything the app is built from, decided once at launch: the build kind,
/// the issuer and relay, the transports, the stores and the browser.
struct AppEnvironment: Sendable {
  let buildKind: BuildKind
  /// Nil is the hub (`defaultIssuer`).
  let issuer: String?
  let relayOverride: String?
  let transport: any HTTPTransport
  let webSocketTransport: any WebSocketTransport
  let secureStore: any SecureStore
  let keyValueStore: any KeyValueStore
  let opener: any AuthenticationSessionOpener
  /// Whether the phone asks for notification permission and an APNs token;
  /// the UI-test fake does neither, so no system alert covers a test.
  let usesRemoteNotifications: Bool
  /// The defaults the appearance is kept in.
  let appearanceDefaults: UserDefaults
  /// True when the developer connection is offered (a development build).
  var offersDeveloperConnection: Bool { buildKind == .development }

  /// The environment of this process.
  static func live(_ options: LaunchOptions = .current()) -> AppEnvironment {
    #if DEBUG
      if options.usesUITestFake { return uiTestFake() }
    #endif
    return AppEnvironment(
      buildKind: options.buildKind,
      issuer: options.issuerOverride,
      relayOverride: options.relayOverride,
      transport: URLSessionTransport(),
      webSocketTransport: URLSessionWebSocketTransport(),
      secureStore: KeychainSecureStore(),
      keyValueStore: FileKeyValueStore(directory: applicationSupportDirectory()),
      opener: WebAuthenticationOpener(),
      usesRemoteNotifications: true,
      appearanceDefaults: .standard)
  }

  /// The pieces given by hand, for a test.
  init(
    buildKind: BuildKind, issuer: String?, relayOverride: String?, transport: any HTTPTransport,
    webSocketTransport: any WebSocketTransport, secureStore: any SecureStore, keyValueStore: any KeyValueStore,
    opener: any AuthenticationSessionOpener, usesRemoteNotifications: Bool, appearanceDefaults: UserDefaults
  ) {
    self.buildKind = buildKind
    self.issuer = issuer
    self.relayOverride = relayOverride
    self.transport = transport
    self.webSocketTransport = webSocketTransport
    self.secureStore = secureStore
    self.keyValueStore = keyValueStore
    self.opener = opener
    self.usesRemoteNotifications = usesRemoteNotifications
    self.appearanceDefaults = appearanceDefaults
  }

  #if DEBUG
    /// Every call answered in process, every store in memory: a UI test starts clean each launch.
    static func uiTestFake() -> AppEnvironment {
      let server = UITestFakeServer()
      let defaults = UserDefaults(suiteName: "clave.ui-test-fake") ?? .standard
      defaults.removePersistentDomain(forName: "clave.ui-test-fake")
      return AppEnvironment(
        buildKind: .development,
        issuer: UITestFakeServer.hubOrigin,
        relayOverride: nil,
        transport: UITestFakeTransport(server: server),
        webSocketTransport: UITestFakeWebSocketTransport(server: server),
        secureStore: InMemorySecureStore(),
        keyValueStore: InMemoryKeyValueStore(),
        opener: UITestFakeOpener(),
        usesRemoteNotifications: false,
        appearanceDefaults: defaults)
    }
  #endif

  /// The app's own state lives beside its other support files, out of the
  /// person's Documents, and is never synced as a document.
  private static func applicationSupportDirectory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("Clave", isDirectory: true)
  }
}
