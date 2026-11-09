import Foundation

// The notification categories the phone declares to the platform and the
// actions each carries (decision 9 of the spec): allow and deny on a
// permission, a reply field on a question, a plain tap everywhere. The
// identifiers are the ones the server names, `clave.<category>` in
// `aps.category`, so a push lands on its buttons without the phone touching
// it. Data only: the app builds UNNotificationCategory objects from it.

/// One action button, as data.
public struct NotificationActionSpec: Sendable, Equatable {
  public let action: NotificationAction
  /// The platform identifier, `clave.<action>`.
  public let identifier: String
  public let title: String
  /// True when the button opens a text field (`UNTextInputNotificationAction`).
  public let takesTextInput: Bool
  public let textInputButtonTitle: String?
  public let textInputPlaceholder: String?
  /// Allow and reply are the person's word, not a pocket's: they need the phone unlocked.
  public let requiresAuthentication: Bool
  public let destructive: Bool
  /// True when the button brings the app to the foreground.
  public let opensApp: Bool
}

/// One category and its buttons, as data.
public struct NotificationCategorySpec: Sendable, Equatable {
  public let category: NotificationCategory
  /// The platform identifier, `clave.<category>`.
  public let identifier: String
  public let actions: [NotificationActionSpec]
}

extension NotificationAction {
  /// The action's platform identifier, `clave.<action>`.
  public var identifier: String { "clave.\(rawValue)" }

  /// The action of a platform identifier, nil for a plain tap or another app's.
  public init?(identifier: String) {
    guard identifier.hasPrefix("clave.") else { return nil }
    self.init(rawValue: String(identifier.dropFirst("clave.".count)))
  }

  /// The button this action is drawn as.
  public var spec: NotificationActionSpec {
    switch self {
    case .allow:
      return NotificationActionSpec(
        action: self, identifier: identifier, title: "Allow", takesTextInput: false, textInputButtonTitle: nil,
        textInputPlaceholder: nil, requiresAuthentication: true, destructive: false, opensApp: false)
    case .deny:
      // Refusing is safe from the lock screen.
      return NotificationActionSpec(
        action: self, identifier: identifier, title: "Deny", takesTextInput: false, textInputButtonTitle: nil,
        textInputPlaceholder: nil, requiresAuthentication: false, destructive: true, opensApp: false)
    case .reply:
      return NotificationActionSpec(
        action: self, identifier: identifier, title: "Reply", takesTextInput: true, textInputButtonTitle: "Send",
        textInputPlaceholder: "Your answer", requiresAuthentication: true, destructive: false, opensApp: false)
    case .open:
      return NotificationActionSpec(
        action: self, identifier: identifier, title: "Open", takesTextInput: false, textInputButtonTitle: nil,
        textInputPlaceholder: nil, requiresAuthentication: true, destructive: false, opensApp: true)
    }
  }
}

/// Every category with its buttons. A plain tap is the open everywhere, so
/// no category draws an Open button of its own.
public func notificationCategories() -> [NotificationCategorySpec] {
  NotificationCategory.allCases.map { category in
    let actions: [NotificationAction]
    switch category {
    case .permission: actions = [.allow, .deny]
    case .question: actions = [.reply]
    default: actions = []
    }
    return NotificationCategorySpec(category: category, identifier: category.categoryId, actions: actions.map(\.spec))
  }
}

/// The category of a notification's own identifier (`clave.permission`), or nil.
public func notificationCategory(ofIdentifier identifier: String?) -> NotificationCategory? {
  guard let identifier, identifier.hasPrefix("clave.") else { return nil }
  return NotificationCategory(rawValue: String(identifier.dropFirst("clave.".count)))
}
