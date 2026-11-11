import ClaveCore
import UIKit
import UserNotifications

/// The platform's callbacks the SwiftUI life cycle does not carry: the APNs
/// token and the notifications, each handed to the app model.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var model: AppModel?

  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.setNotificationCategories(Self.categories())
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    guard let model else { return }
    Task { await model.didRegisterForRemoteNotifications(deviceToken: deviceToken) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    model?.didFailToRegisterForRemoteNotifications()
  }

  /// A notification arriving while the app is in front still shows its banner.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let input = NotificationResponseInput(response: response)
    guard let model = await self.model else { return }
    await model.handleNotification(response: input)
  }

  /// The categories the server names in `aps.category`, with their buttons.
  static func categories() -> Set<UNNotificationCategory> {
    Set(
      notificationCategories().map { category in
        UNNotificationCategory(
          identifier: category.identifier, actions: category.actions.map(action), intentIdentifiers: [],
          options: [])
      })
  }

  private static func action(_ spec: NotificationActionSpec) -> UNNotificationAction {
    var options: UNNotificationActionOptions = []
    if spec.requiresAuthentication { options.insert(.authenticationRequired) }
    if spec.destructive { options.insert(.destructive) }
    if spec.opensApp { options.insert(.foreground) }
    if spec.takesTextInput {
      return UNTextInputNotificationAction(
        identifier: spec.identifier, title: spec.title, options: options,
        textInputButtonTitle: spec.textInputButtonTitle ?? "Send", textInputPlaceholder: spec.textInputPlaceholder ?? "")
    }
    return UNNotificationAction(identifier: spec.identifier, title: spec.title, options: options)
  }
}
