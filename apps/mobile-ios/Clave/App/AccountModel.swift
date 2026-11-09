import ClaveCore
import Foundation
import Observation

/// The Antasphere account on this phone, over `HubSignIn`: where the sign-in
/// stands, and the namespace every record of the signed-in person is filed
/// under. The namespace is the line between two people on one phone: a model
/// built for one owner keeps that owner's stores for its whole life and never
/// sees the next one's (docs/mobile-beta.md, "Account separation").
@Observable @MainActor final class AccountModel {
  /// Nil only until the first read of the sign-in, a moment after launch.
  private(set) var status: AuthStatus?

  @ObservationIgnored let hub: HubSignIn
  @ObservationIgnored private let secureStore: any SecureStore
  @ObservationIgnored private let keyValueStore: any KeyValueStore
  @ObservationIgnored private var listener: Task<Void, Never>?
  @ObservationIgnored private var appliedNamespace: String?

  /// Called with the new namespace when the signed-in person changes (nil: signed out).
  @ObservationIgnored var onOwnerChange: ((String?) -> Void)?
  /// Runs before the hub's login is forgotten, while the owner's credentials still work.
  @ObservationIgnored var beforeSignOut: (@MainActor () async -> Void)?

  init(environment: AppEnvironment) {
    secureStore = environment.secureStore
    keyValueStore = environment.keyValueStore
    hub = HubSignIn(
      issuer: environment.issuer, transport: environment.transport, secureStore: environment.secureStore,
      opener: environment.opener, log: { code, _ in AppLog.event(code) })
  }

  var phase: AuthPhase { status?.phase ?? .signedOut }
  var person: StoredAccount? { status?.account }
  var isSignedIn: Bool { person != nil }

  /// The signed-in person's namespace, nil when nobody is signed in.
  var ownerNamespace: String? {
    guard let status, let subject = status.account?.subject else { return nil }
    return ClaveCore.ownerNamespace(issuer: status.issuer, subject: subject)
  }

  /// The app's secure store seen through the owner's namespace.
  var ownerSecureStore: OwnerScopedSecureStore? {
    ownerNamespace.map { OwnerScopedSecureStore(base: secureStore, namespace: $0) }
  }

  /// The app's key-value store seen through the owner's namespace.
  var ownerKeyValueStore: OwnerScopedKeyValueStore? {
    ownerNamespace.map { OwnerScopedKeyValueStore(base: keyValueStore, namespace: $0) }
  }

  /// The last failure as a short sentence, nil when there is none to show.
  var failureSentence: String? {
    guard let failure = status?.lastFailure else { return nil }
    return Self.sentence(failure)
  }

  /// Reads what the phone kept, then follows every change of the sign-in.
  func restore() async {
    apply(await hub.restore())
    guard listener == nil else { return }
    let stream = await hub.statusStream()
    listener = Task { [weak self] in
      for await status in stream {
        self?.apply(status)
      }
    }
  }

  func signIn() async {
    apply(await hub.signIn())
  }

  func signOut() async {
    await beforeSignOut?()
    apply(await hub.signOut())
  }

  private func apply(_ next: AuthStatus) {
    status = next
    let namespace = ownerNamespace
    guard namespace != appliedNamespace else { return }
    appliedNamespace = namespace
    onOwnerChange?(namespace)
  }

  /// The prototype's words for each failure, said as a sentence.
  static func sentence(_ failure: AuthFailure) -> String {
    switch failure {
    case .cancelled: "The sign-in was cancelled. Try again."
    case .denied: "The sign-in was refused. Try again."
    case .network: "The hub could not be reached. Check the connection and try again."
    case .timeout: "The hub did not answer in time. Try again."
    case .invalidResponse: "The hub's answer could not be read. Try again."
    case .registration: "This phone could not register with the hub. Try again."
    case .storage: "The sign-in could not be kept on this phone. Try again."
    case .configuration: "This build's sign-in address is refused."
    case .expired: "Your sign-in expired. Sign in again."
    case .clientPurged: "The hub no longer knows this phone. Sign in again."
    }
  }

  nonisolated deinit {}
}
