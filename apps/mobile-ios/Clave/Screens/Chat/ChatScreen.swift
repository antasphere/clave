import ClaveCore
import SwiftUI
import UIKit

/// One conversation: the header with the agent's state, the transcript, the composer at the foot.
struct ChatScreen: View {
  @Bindable var model: ConversationModel

  @Environment(\.claveTheme) private var theme
  @State private var atBottom = true

  init(model: ConversationModel) {
    self.model = model
  }

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader(model.title, status: statusKind(model.agentState)) {
        if model.agentState == .working {
          Button {
            Task { await model.interrupt() }
          } label: {
            HStack(spacing: Theme.space(1)) {
              Icon(.stop, size: Theme.controlSm.icon)
              Text("Stop")
            }
          }
          .buttonStyle(.clave(.secondary, size: .small))
          .accessibilityIdentifier("chat.interrupt")
          .accessibilityLabel("Stop the agent")
        }
      }
      transcript
    }
    .background(theme.colors.surface0)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(model: model)
    }
    .task { await model.appear() }
    .onDisappear { model.disappear() }
  }

  // MARK: - The transcript

  @ViewBuilder
  private var transcript: some View {
    switch model.state {
    case .loading where model.conversation == nil:
      ProgressView()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Loading the conversation")
        .accessibilityIdentifier("chat.loading")
    case .failed(let message) where model.conversation == nil:
      failure(message)
    default:
      if let conversation = model.conversation {
        if conversation.items.isEmpty && !model.canLoadOlder {
          ScrollView {
            EmptyState(icon: .chatBubbleLeftRight, title: "Start a conversation", text: "Ask a question or describe what you want to build.")
              .padding(.top, Theme.space(16))
              .accessibilityIdentifier("chat.empty")
          }
        } else {
          rows(conversation)
        }
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }

  private func failure(_ message: String) -> some View {
    ScrollView {
      VStack(spacing: Theme.space(3)) {
        Icon(.exclamationTriangle, size: 22)
          .foregroundStyle(theme.colors.textTertiary)
        Text(message)
          .font(.geist(Theme.text.sm, relativeTo: .body))
          .foregroundStyle(theme.colors.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(Theme.space(6))
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("chat.failed")
    }
  }

  private func rows(_ conversation: Conversation) -> some View {
    let blocks = groupItems(visibleItems(conversation.items))
    let actions = ChatActions(
      answer: { card, optionId, answers in await model.answerPermission(card, optionId: optionId, answers: answers) },
      openDocument: { card in try await model.openDocument(card) })
    return ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: Theme.space(5)) {
          header(conversation)
          ForEach(blocks, id: \.key) { block in
            TranscriptRow(block: block, actions: actions)
          }
          footer(conversation)
          Color.clear
            .frame(height: 1)
            .id(bottomId)
            .onAppear { atBottom = true }
            .onDisappear { atBottom = false }
            .accessibilityHidden(true)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, Theme.space(4))
        .padding(.bottom, Theme.space(2))
      }
      .scrollDismissesKeyboard(.interactively)
      .accessibilityIdentifier("chat.transcript")
      // The transcript appears with the conversation's first load, and again on each return to
      // the chat: it opens at the latest. A scroll rather than a default anchor, because iOS 17.5
      // aligned a short transcript's accessibility frames to the anchor while drawing it at the top.
      .onAppear { proxy.scrollTo(bottomId, anchor: .bottom) }
      // The keyboard covers the transcript's foot: a reader at the latest stays at the latest.
      .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
        if atBottom { withAnimation { proxy.scrollTo(bottomId, anchor: .bottom) } }
      }
      .onChange(of: tailSignature(conversation)) { _, _ in
        // Follow the agent while the reader is at the latest; leave them where they are otherwise.
        if atBottom { proxy.scrollTo(bottomId, anchor: .bottom) }
      }
      .overlay(alignment: .bottom) {
        if !atBottom {
          Button {
            withAnimation { proxy.scrollTo(bottomId, anchor: .bottom) }
          } label: {
            HStack(spacing: Theme.space(1)) {
              Icon(.chevronDown, size: 12)
              Text("Jump to latest")
            }
            .font(.geist(Theme.text.xs, relativeTo: .caption))
            .foregroundStyle(theme.colors.textPrimary)
            .padding(.horizontal, Theme.space(3))
            .frame(minHeight: 32)
            .background(Capsule().fill(theme.colors.surfaceRaised))
            .overlay(Capsule().strokeBorder(theme.colors.borderSubtle, lineWidth: 1))
            .claveShadow(theme.overlay)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .padding(.bottom, Theme.space(2))
          .accessibilityIdentifier("chat.jump-to-latest")
        }
      }
    }
  }

  @ViewBuilder
  private func header(_ conversation: Conversation) -> some View {
    if model.truncated {
      Text("History is incomplete: this server keeps only recent events.")
        .font(.geist(Theme.text.xs, relativeTo: .caption))
        .foregroundStyle(theme.colors.textTertiary)
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
        .accessibilityIdentifier("chat.truncated")
    }
    if model.loadingOlder {
      HStack(spacing: Theme.space(1.5)) {
        ProgressView().controlSize(.small)
        Text("Reading earlier messages…")
          .font(.geist(Theme.text.xs, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
      }
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .combine)
    } else if model.canLoadOlder {
      Button("Load earlier") {
        Task { await model.loadOlder() }
      }
      .buttonStyle(.clave(.secondary, size: .small))
      .frame(maxWidth: .infinity)
      .accessibilityIdentifier("chat.load-earlier")
    }
    if case .failed(let message) = model.state {
      // A refresh failed over a transcript already shown: the transcript stays, the sentence says why.
      Text(message)
        .font(.geist(Theme.text.xs, relativeTo: .caption))
        .foregroundStyle(theme.colors.destructive)
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
        .accessibilityIdentifier("chat.failed")
    }
  }

  @ViewBuilder
  private func footer(_ conversation: Conversation) -> some View {
    if conversation.state == .ended {
      Text(conversation.exitCode.map { "Session ended (exit \($0))" } ?? "Session ended")
        .font(.geist(Theme.text.xs, relativeTo: .caption))
        .foregroundStyle(theme.colors.textTertiary)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("chat.ended")
    }
  }

  private let bottomId = "chat.bottom"

  /// Changes whenever the foot of the transcript does: a new row, or the last turn growing.
  private func tailSignature(_ conversation: Conversation) -> String {
    guard let last = conversation.items.last else { return "0" }
    let size: Int
    switch last {
    case .assistant(let turn): size = turn.text.utf16.count
    case .tool(let call), .document(let call): size = call.complete ? 1 : 0
    default: size = 0
    }
    return "\(conversation.first + conversation.items.count):\(size)"
  }
}

/// The header's dot for an agent's state.
func statusKind(_ state: AgentState) -> StatusKind {
  switch state {
  case .idle: .ready
  case .working: .working
  case .blocked: .waiting
  case .done, .ended: .inactive
  }
}

extension ConversationBlock {
  /// The block's key for good, as the core defines it.
  nonisolated var key: String { blockKey(self) }
}
