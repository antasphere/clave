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
  #if DEBUG
    /// A URL the launch hands to the app as if the platform had opened it (`CLAVE_IOS_OPEN_URL`).
    var openURL: URL? = nil
    /// The fake asks for the notification permission like a real launch, for a test that pushes.
    var uiTestFakeAsksForNotifications = false
    /// The fake's seeded chat holds 300 alternating turns instead of its evidence, for a test that
    /// times the transcript's open.
    var uiTestFakeLongChat = false
  #endif

  static let release = LaunchOptions(buildKind: .release, issuerOverride: nil, relayOverride: nil, usesUITestFake: false)

  #if DEBUG
    static let uiTestFakeArgument = "--ui-test-fake"
    static let issuerVariable = "CLAVE_IOS_ISSUER"
    static let relayVariable = "CLAVE_IOS_RELAY"
    static let openURLVariable = "CLAVE_IOS_OPEN_URL"
    static let uiTestNotificationsArgument = "--ui-test-notifications"
    static let uiTestLongChatArgument = "--ui-test-long-chat"

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
        usesUITestFake: arguments.contains(uiTestFakeArgument),
        openURL: value(openURLVariable).flatMap(URL.init(string:)),
        uiTestFakeAsksForNotifications: arguments.contains(uiTestNotificationsArgument),
        uiTestFakeLongChat: arguments.contains(uiTestLongChatArgument))
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
  #if DEBUG
    /// A URL the launch opens once it has read the sign-in, as `CLAVE_IOS_OPEN_URL` named it.
    var openURLAtLaunch: URL?
  #endif
  /// True when the developer connection is offered (a development build).
  var offersDeveloperConnection: Bool { buildKind == .development }

  /// The environment of this process.
  static func live(_ options: LaunchOptions = .current()) -> AppEnvironment {
    #if DEBUG
      if options.usesUITestFake {
        return uiTestFake(asksForNotifications: options.uiTestFakeAsksForNotifications, longChat: options.uiTestFakeLongChat)
          .opening(options.openURL)
      }
    #endif
    let live = AppEnvironment(
      buildKind: options.buildKind,
      issuer: options.issuerOverride,
      relayOverride: options.relayOverride,
      transport: URLSessionTransport(),
      webSocketTransport: URLSessionWebSocketTransport(),
      secureStore: KeychainSecureStore(service: storageNames(bundleIdentifier: Bundle.main.bundleIdentifier).keychainService),
      keyValueStore: FileKeyValueStore(directory: applicationSupportDirectory()),
      opener: WebAuthenticationOpener(),
      usesRemoteNotifications: true,
      appearanceDefaults: .standard)
    #if DEBUG
      return live.opening(options.openURL)
    #else
      return live
    #endif
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
    /// The same environment with a URL to open at launch.
    func opening(_ url: URL?) -> AppEnvironment {
      var copy = self
      copy.openURLAtLaunch = url
      return copy
    }

    /// Every call answered in process, every store in memory: a UI test starts clean each launch.
    /// `asksForNotifications` lets a test that pushes get the permission alert and an APNs token;
    /// `longChat` seeds the chat with 300 turns.
    static func uiTestFake(asksForNotifications: Bool = false, longChat: Bool = false) -> AppEnvironment {
      let server = UITestFakeServer(longChat: longChat)
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
        usesRemoteNotifications: asksForNotifications,
        appearanceDefaults: defaults)
    }
  #endif

  /// The names the live stores are filed under, from the app's bundle identifier, so a Debug and
  /// a Release install (com.clave.ios.dev, com.clave.ios) never share one. The Keychain service is
  /// the one name the app chooses: the key-value store is a folder in the app's own container and
  /// the appearance lives in its standard defaults, which the system keeps per identifier.
  nonisolated struct StorageNames: Equatable, Sendable {
    /// The service every Keychain item is filed under.
    let keychainService: String
  }

  /// The identifier a bundle that has none is taken for: the development build's.
  nonisolated static let fallbackBundleIdentifier = "com.clave.ios.dev"

  nonisolated static func storageNames(bundleIdentifier: String?) -> StorageNames {
    StorageNames(keychainService: "\(bundleIdentifier ?? fallbackBundleIdentifier).credentials")
  }

  /// The app's own state lives beside its other support files, out of the
  /// person's Documents, and is never synced as a document.
  private static func applicationSupportDirectory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("Clave", isDirectory: true)
  }
}
