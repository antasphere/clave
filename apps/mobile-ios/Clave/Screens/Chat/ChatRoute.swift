import ClaveCore
import SwiftUI

/// The `.chat` route: the machine's connection, the session on it, then the conversation's model
/// (kept by the app model, so leaving and coming back keeps it) and the Chat screen over it.
struct ChatRoute: View {
  let model: AppModel
  let machineId: String
  let sessionId: String

  var body: some View {
    ConnectionView(model: model, machineId: machineId) { connection in
      ChatRouteContent(model: model, connection: connection, sessionId: sessionId)
    }
  }
}

private struct ChatRouteContent: View {
  let model: AppModel
  let connection: MachineConnection
  let sessionId: String

  @Environment(\.claveTheme) private var theme
  @State private var conversation: ConversationModel?
  @State private var answered = false

  var body: some View {
    Group {
      if let conversation {
        ChatScreen(model: conversation)
      } else if answered {
        EmptyState(icon: .chatBubbleLeftRight, title: "This conversation is not on the machine any more.")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityIdentifier("chat.missing")
      } else {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel("Opening the conversation")
          .accessibilityIdentifier("chat.opening")
      }
    }
    .background(theme.colors.surface0)
    .task(id: sessionId) {
      answered = false
      conversation = await model.conversation(for: connection.machineId, sessionId: sessionId, in: connection)
      answered = true
    }
  }
}
