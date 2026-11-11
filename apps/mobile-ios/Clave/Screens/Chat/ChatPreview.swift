import ClaveCore
import SwiftUI

// The transcript's rows on sample data, under every theme, so the look can be checked in Xcode
// without a machine. Nothing here reaches the network: the document reads from memory and the
// sample has no remote image.

enum ChatSamples {
  static let markdown = """
    ## What changed

    The composer now keeps the **draft** through a restart, and `send()` clears it once the server \
    accepted the message. See [the spec](https://example.com/spec).

    1. The draft is saved on every edit.
    2. The send table runs when the answer is lost:
       - `absent` retries once with the same id
       - `unknown` sends nothing more

    | Outcome | Draft | Mark |
    | :------ | :---: | ---: |
    | sent | cleared | none |
    | unknown | kept | two choices |

    ```swift
    let id = mintClientMessageId() // a fresh id
    let outcome = await sendMessage(id, ports: ports)
    ```

    > The delivery is never retried by itself.

    ---
    """

  static var conversation: Conversation {
    var c = Conversation.empty
    let events: [SessionEvent] = [
      .userMessage(UserMessage(clientMessageId: "m-1", text: "Make the composer keep its draft.", attachments: [
        .file(FileAttachment(id: "f1", label: "Image #1", path: "/tmp/a.png", name: "screen.png", mimeType: "image/png", size: 2048, delivery: .image)),
      ])),
      .assistantText(delta: markdown, final: true, parent: nil),
      .toolCall(id: "t1", name: "Read", input: .object(["file_path": .string("apps/mobile-ios/Clave/Screens/Chat/Composer.swift")]), parent: nil),
      .toolResult(id: "t1", output: .string("import SwiftUI\n\nstruct Composer: View {\n  …\n}"), error: nil, parent: nil),
      .toolCall(id: "t2", name: "Bash", input: .object(["command": .string("swift test")]), parent: nil),
      .toolResult(id: "t2", output: .string("error: 1 test failed"), error: true, parent: nil),
      .toolCall(id: "t3", name: "mcp__clave__clave_open_side_panel", input: .object(["path": .string("/Users/me/notes/plan.md"), "title": .string("The plan")]), parent: nil),
      .permissionRequest(PermissionRequestEvent(
        id: "p1", description: "Run swift build", options: [PermissionOption(id: "allow", label: "Allow"), PermissionOption(id: "deny", label: "Deny")],
        toolName: "Bash", detail: "In apps/mobile-ios")),
      .permissionRequest(PermissionRequestEvent(
        id: "p2", description: "Which theme?", options: [PermissionOption(id: "answer", label: "Answer"), PermissionOption(id: "cancel", label: "Skip")],
        questions: [AgentQuestion(id: "theme", question: "Which theme should the preview use?", header: "Theme", options: [AgentQuestionOption(label: "Dark"), AgentQuestionOption(label: "Light", description: "The bright one")])])),
      .error(message: "The provider stopped answering.", fatal: false),
    ]
    for (index, event) in events.enumerated() {
      c = reduceConversation(c, .event(event, at: Double(index)))
    }
    return c
  }

  static let actions = ChatActions(
    answer: { _, _, _ in },
    openDocument: { _ in FileText(content: "# The plan\n\nShip the chat.", truncated: false, size: 26, binary: false) })
}

/// The rows alone, as the transcript lays them out.
struct ChatTranscriptPreview: View {
  let theme: Theme

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Theme.space(5)) {
        ForEach(groupItems(visibleItems(ChatSamples.conversation.items)), id: \.key) { block in
          TranscriptRow(block: block, actions: ChatSamples.actions)
        }
        DeliveryMarkBar(reason: "The server cannot say whether the message arrived.", resend: {}, discard: {})
      }
      .padding(Theme.gutter)
    }
    .background(theme.colors.surface0)
    .claveTheme(theme)
  }
}

#Preview("Transcript, dark") { ChatTranscriptPreview(theme: Theme(.dark)) }
#Preview("Transcript, light") { ChatTranscriptPreview(theme: Theme(.light)) }
#Preview("Transcript, coffee") { ChatTranscriptPreview(theme: Theme(.coffee)) }
#Preview("Transcript, charcoal") { ChatTranscriptPreview(theme: Theme(.charcoal)) }
#Preview("Transcript, largest type") {
  ChatTranscriptPreview(theme: Theme(.dark))
    .dynamicTypeSize(.accessibility5)
}
