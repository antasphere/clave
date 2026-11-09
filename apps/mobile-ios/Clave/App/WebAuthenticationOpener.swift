import AuthenticationServices
import ClaveCore
import UIKit

/// The system browser the sign-in runs in: an ASWebAuthenticationSession,
/// never a web view inside the app, so the person types their password into
/// a page the app cannot read. The browser's own cookies are kept, so a
/// person already signed in at the hub in Safari is not asked again.
nonisolated struct WebAuthenticationOpener: AuthenticationSessionOpener {
  func open(_ url: URL, callbackScheme: String) async throws -> URL? {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL?, Error>) in
      Task { @MainActor in
        guard let window = BrowserAnchor.keyWindow() else {
          continuation.resume(throwing: ASWebAuthenticationSessionError(.presentationContextInvalid))
          return
        }
        let anchor = BrowserAnchor(window: window)
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callback, error in
          Task { @MainActor in BrowserAnchor.current = nil }
          if let error {
            if let auth = error as? ASWebAuthenticationSessionError, auth.code == .canceledLogin {
              continuation.resume(returning: nil)
            } else {
              continuation.resume(throwing: error)
            }
            return
          }
          continuation.resume(returning: callback)
        }
        session.presentationContextProvider = anchor
        session.prefersEphemeralWebBrowserSession = false
        // The session is not kept alive by the system while it runs.
        BrowserAnchor.current = (session, anchor)
        if !session.start() {
          BrowserAnchor.current = nil
          continuation.resume(throwing: ASWebAuthenticationSessionError(.presentationContextInvalid))
        }
      }
    }
  }
}

/// The key window the browser sheet is presented over.
private final class BrowserAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
  static var current: (ASWebAuthenticationSession, BrowserAnchor)?

  private let window: UIWindow

  init(window: UIWindow) {
    self.window = window
  }

  static func keyWindow() -> UIWindow? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    return windows.first(where: \.isKeyWindow) ?? windows.first
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { window }
  }
}
