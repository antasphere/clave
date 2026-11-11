import os

/// The app's log: event codes only. Never a token, a URL that could carry a
/// bearer, a person's name or a conversation's text.
nonisolated enum AppLog {
  private static let logger = Logger(subsystem: "com.clave.ios.dev", category: "app")

  static func event(_ code: String) {
    logger.info("\(code, privacy: .public)")
  }
}
