import ClaveCore
import SwiftUI

// The rows of the transcript, as the desktop's chat view draws them: the person's turn boxed,
// the agent's prose on the ground, tool runs folded into one card, permission cards with their
// options, documents opened from the Mac. Each row takes its writes as closures so it draws the
// same in a preview as on a live conversation.

/// What a row may ask the conversation to do.
struct ChatActions {
  var answer: @MainActor (PermissionCard, String, [String: String]?) async -> Void = { _, _, _ in }
  var openDocument: @MainActor (DocumentCard) async throws -> FileText = { _ in
    throw ServerError(.protocol, "Documents cannot be read here.")
  }
}

/// One block of the transcript.
struct TranscriptRow: View {
  let block: ConversationBlock
  let actions: ChatActions

  var body: some View {
    switch block {
    case .item(.user(let turn)):
      UserTurnView(turn: turn)
    case .item(.assistant(let turn)):
      AssistantTurnView(turn: turn)
    case .item(.tool(let call)):
      ToolRunCard(id: call.id, tools: [call])
    case .item(.document(let call)):
      DocumentCardView(call: call, open: actions.openDocument)
    case .item(.permission(let card)):
      PermissionCardView(card: card, answer: actions.answer)
    case .item(.error(let item)):
      ErrorItemView(item: item)
    case .toolGroup(let id, let tools):
      ToolRunCard(id: id, tools: tools)
    case .approvalGroup(let cards):
      ApprovalRunView(cards: cards)
    case .deliveryGroup(let turns):
      VStack(alignment: .trailing, spacing: Theme.space(3)) {
        ForEach(turns, id: \.ordinal) { turn in UserTurnView(turn: turn) }
      }
    }
  }
}

// MARK: - The person's turn

struct UserTurnView: View {
  let turn: UserTurn

  @Environment(\.claveTheme) private var theme

  var body: some View {
    let delivery = parseDelivery(turn.text)
    let body = (delivery?.body ?? turn.text).trimmingCharacters(in: .whitespacesAndNewlines)
    let shape = RoundedRectangle(cornerRadius: Theme.radius.xxl, style: .continuous)
    VStack(alignment: .trailing, spacing: Theme.space(1.5)) {
      if !turn.attachments.isEmpty {
        AttachmentChips(attachments: turn.attachments)
      }
      if !body.isEmpty {
        VStack(alignment: .leading, spacing: Theme.space(1.5)) {
          if let delivery {
            HStack(spacing: Theme.space(1)) {
              Icon(.arrowTurnDownRight, size: 12)
              Text(delivery.senderName ?? "Another agent")
                .font(.geist(Theme.text.xs, relativeTo: .caption))
                .lineLimit(1)
            }
            .foregroundStyle(theme.colors.termModel)
          }
          Text(body)
            .font(.geist(Theme.text.sm, weight: .regular, relativeTo: .body))
            .foregroundStyle(turn.interrupted ? theme.colors.textTertiary : theme.colors.textPrimary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Theme.space(3.5))
        .padding(.vertical, Theme.space(2.5))
        .background(shape.fill(delivery == nil ? theme.colors.surfaceRaised : theme.colors.termModel.opacity(0.12)))
        .overlay(shape.strokeBorder(theme.colors.border, lineWidth: 1))
      }
      if turn.interrupted {
        Text("Interrupted")
          .font(.geist(Theme.text.xs, relativeTo: .caption))
          .foregroundStyle(theme.colors.textTertiary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, Theme.space(8))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(userLabel(delivery: delivery, body: body))
    .accessibilityIdentifier("chat.user.\(turn.clientMessageId ?? String(turn.ordinal))")
  }

  private func userLabel(delivery: ParsedDelivery?, body: String) -> String {
    var parts: [String] = [delivery.map { "From \($0.senderName ?? "another agent")" } ?? "You"]
    if !turn.attachments.isEmpty {
      parts.append(turn.attachments.count == 1 ? "1 attachment" : "\(turn.attachments.count) attachments")
    }
    parts.append(body)
    if turn.interrupted { parts.append("Interrupted") }
    return parts.joined(separator: ", ")
  }
}

/// The records a message carries, as chips.
struct AttachmentChips: View {
  let attachments: [Attachment]

  var body: some View {
    FlowRow(spacing: Theme.space(1)) {
      ForEach(attachments, id: \.id) { attachment in
        Chip(chipTitle(attachment), icon: chipIcon(attachment))
      }
    }
  }

  private func chipTitle(_ attachment: Attachment) -> String {
    switch attachment {
    case .file(let file): return file.label.map { "\($0) · \(file.name)" } ?? file.name
    case .session(let session): return session.label.map { "\($0) · \(session.name)" } ?? session.name
    }
  }

  private func chipIcon(_ attachment: Attachment) -> IconName {
    switch attachment {
    case .file(let file):
      switch file.delivery {
      case .image: return .photo
      case .folder: return .folder
      case .reference: return .document
      }
    case .session: return .chatBubbleLeftRight
    }
  }
}

/// Chips that wrap onto the next line instead of running off the screen.
struct FlowRow: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        y += line + spacing
        x = 0
        line = 0
      }
      x += size.width + spacing
      widest = max(widest, x - spacing)
      line = max(line, size.height)
    }
    return CGSize(width: min(widest, width), height: y + line)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX {
        y += line + spacing
        x = bounds.minX
        line = 0
      }
      subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      line = max(line, size.height)
    }
  }
}

// MARK: - The agent's prose

struct AssistantTurnView: View {
  let turn: AssistantTurn

  var body: some View {
    // Each drawn block is an element of its own (the heading, the paragraphs and their links, the
    // code, the table's cells, the image), so VoiceOver reads the prose and never its Markdown source.
    MarkdownView(text: turn.text)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat.assistant.\(turn.ordinal)")
  }
}

// MARK: - Tool runs

private func toolIcon(_ kind: ToolKind) -> IconName {
  switch kind {
  case .read: .eye
  case .search: .magnifyingGlass
  case .edit: .pencilSquare
  case .command: .commandLine
  case .skill: .bookOpen
  case .web: .globeAlt
  case .agent: .cpuChip
  case .other: .wrench
  }
}

/// A run of tool calls folded into one card: the summary, how it stands, and each call opening to
/// its input and output.
struct ToolRunCard: View {
  let id: String
  let tools: [ToolCall]

  @Environment(\.claveTheme) private var theme
  @State private var open = false
  @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = Theme.chatGlyph

  var body: some View {
    let status = groupStatus(tools)
    let failures = failureCount(tools)
    let summary = toolGroupSummary(tools)
    VStack(alignment: .leading, spacing: Theme.space(2)) {
      Button {
        open.toggle()
      } label: {
        HStack(spacing: Theme.space(2)) {
          Icon(toolIcon(groupKind(tools)), size: glyph)
            .foregroundStyle(theme.colors.textTertiary)
          Text(summary)
            .font(.geist(Theme.codeSize, relativeTo: .callout))
            .foregroundStyle(theme.colors.textSecondary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
          if status == .running {
            ProgressView().controlSize(.small)
          }
          if failures > 0 {
            Text(failures == 1 ? "1 failed" : "\(failures) failed")
              .font(.geist(Theme.text.xs, relativeTo: .caption))
              .foregroundStyle(theme.colors.destructive)
          }
          Icon(open ? .chevronDown : .chevronRight, size: glyph)
            .foregroundStyle(theme.colors.textTertiary)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("chat.tool.\(id)")
      .accessibilityLabel(toolLabel(summary: summary, status: status, failures: failures))
      .accessibilityHint(open ? "Collapses the tool calls" : "Shows the tool calls")
      .accessibilityAddTraits(.isButton)

      if open {
        VStack(alignment: .leading, spacing: Theme.space(2)) {
          ForEach(tools, id: \.id) { tool in
            ToolCallRow(tool: tool)
          }
        }
        .padding(.leading, glyph + Theme.space(2))
      }
    }
  }

  private func toolLabel(summary: String, status: GroupStatus, failures: Int) -> String {
    var parts = [summary]
    if status == .running { parts.append("running") }
    if failures > 0 { parts.append(failures == 1 ? "1 failed" : "\(failures) failed") }
    return parts.joined(separator: ", ")
  }
}

/// One call of a run: its verb and target, opening to its sections.
struct ToolCallRow: View {
  let tool: ToolCall

  @Environment(\.claveTheme) private var theme
  @State private var open = false

  var body: some View {
    let description = describeTool(tool, withSections: open)
    VStack(alignment: .leading, spacing: Theme.space(1.5)) {
      Button {
        open.toggle()
      } label: {
        VStack(alignment: .leading, spacing: Theme.space(0.5)) {
          HStack(alignment: .firstTextBaseline, spacing: Theme.space(1.5)) {
            Text(toolVerb(description.kind, description.label))
              .font(.geist(Theme.codeSize, weight: .semibold, relativeTo: .callout))
              .foregroundStyle(theme.colors.textSecondary)
            Text(description.target)
              .font(.mono(Theme.codeSize))
              .foregroundStyle(theme.colors.textSecondary)
              .lineLimit(open ? nil : 1)
            if tool.failed == true {
              Text("Failed")
                .font(.geist(Theme.text.xs, relativeTo: .caption))
                .foregroundStyle(theme.colors.destructive)
            }
          }
          if let detail = description.detail {
            Text(detail)
              .font(.geist(Theme.text.xs, relativeTo: .caption))
              .foregroundStyle(theme.colors.textTertiary)
          }
        }
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("chat.tool.call.\(tool.id)")

      if open {
        let sections = description.sections.isEmpty && tool.input != nil
          ? [ToolSection(label: "Input", text: safeJson(tool.input))]
          : description.sections
        ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
          ToolSectionView(section: section)
        }
      }
    }
  }
}

/// One opened section: its label and its first lines, the rest one tap away.
struct ToolSectionView: View {
  let section: ToolSection

  @Environment(\.claveTheme) private var theme
  @State private var full = false

  var body: some View {
    let preview = toolPreview(section.text)
    let shape = RoundedRectangle(cornerRadius: Theme.radius.lg, style: .continuous)
    VStack(alignment: .leading, spacing: Theme.space(1)) {
      Text(section.label)
        .font(.geist(Theme.text.meta, relativeTo: .caption2))
        .textCase(.uppercase)
        .foregroundStyle(theme.colors.textTertiary)
      ScrollView(.horizontal, showsIndicators: false) {
        Text(full ? section.text : preview.text)
          .font(.mono(Theme.codeSize))
          .foregroundStyle(theme.colors.textPrimary)
          .textSelection(.enabled)
          .fixedSize(horizontal: true, vertical: true)
          .padding(Theme.space(2.5))
      }
      .background(shape.fill(theme.colors.surface50))
      .overlay(shape.strokeBorder(theme.colors.borderSubtle, lineWidth: 1))
      if preview.truncated && !full {
        Button("Show all") { full = true }
          .buttonStyle(.clave(.secondary, size: .small))
      }
    }
  }
}

/// Approvals the reader allowed, folded into one line.
struct ApprovalRunView: View {
  let cards: [PermissionCard]

  @Environment(\.claveTheme) private var theme

  var body: some View {
    let summary = approvalRunSummary(cards)
    HStack(alignment: .firstTextBaseline, spacing: Theme.space(2)) {
      Icon(.shieldCheck, size: Theme.chatGlyph).foregroundStyle(theme.colors.textTertiary)
      VStack(alignment: .leading, spacing: Theme.space(0.5)) {
        Text(summary.head)
          .font(.geist(Theme.codeSize, relativeTo: .callout))
          .foregroundStyle(theme.colors.textSecondary)
        if !summary.detail.isEmpty {
          Text(summary.detail)
            .font(.geist(Theme.text.xs, relativeTo: .caption))
            .foregroundStyle(theme.colors.textTertiary)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Documents

/// A document the agent presented for review: read here, edited on the Mac.
struct DocumentCardView: View {
  let call: ToolCall
  let open: @MainActor (DocumentCard) async throws -> FileText

  @Environment(\.claveTheme) private var theme
  @State private var reading = false

  var body: some View {
    let card = documentCard(call)
    Card {
      VStack(alignment: .leading, spacing: Theme.space(2)) {
        HStack(spacing: Theme.space(2)) {
          Icon(.documentText, size: Theme.chatGlyph).foregroundStyle(theme.colors.textTertiary)
          VStack(alignment: .leading, spacing: Theme.space(0.5)) {
            Text(card.title)
              .font(.geist(Theme.text.sm, weight: .semibold, relativeTo: .body))
              .foregroundStyle(theme.colors.textPrimary)
            Text(card.path.map { "\(card.kindLabel) · \($0)" } ?? card.kindLabel)
              .font(.geist(Theme.text.xs, relativeTo: .caption))
              .foregroundStyle(theme.colors.textTertiary)
              .lineLimit(2)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        Text(card.editingNote)
          .font(.geist(Theme.text.xs, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
        if card.path != nil {
          Button("Read") { reading = true }
            .buttonStyle(.clave(.secondary, size: .small))
            .accessibilityIdentifier("chat.document.\(call.id).read")
            .accessibilityLabel("Read \(card.title)")
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.document.\(call.id)")
    .sheet(isPresented: $reading) {
      DocumentSheet(card: card, open: open)
    }
  }
}

/// The file's text, read from the Mac when the sheet opens.
struct DocumentSheet: View {
  let card: DocumentCard
  let open: @MainActor (DocumentCard) async throws -> FileText

  @Environment(\.claveTheme) private var theme
  @Environment(\.dismiss) private var dismiss
  @State private var file: FileText?
  @State private var failure: String?

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader(card.title, subtitle: card.path) {
        Button("Done") { dismiss() }
          .buttonStyle(.clave(.secondary, size: .small))
          .accessibilityIdentifier("chat.document.done")
      }
      ScrollView {
        VStack(alignment: .leading, spacing: Theme.space(3)) {
          Text(card.editingNote)
            .font(.geist(Theme.text.xs, relativeTo: .caption))
            .foregroundStyle(theme.colors.textSecondary)
          if let failure {
            Text(failure)
              .font(.geist(Theme.text.sm, relativeTo: .body))
              .foregroundStyle(theme.colors.destructive)
          } else if let file {
            if file.binary {
              Text("This file is binary, so it is not shown here.")
                .font(.geist(Theme.text.sm, relativeTo: .body))
                .foregroundStyle(theme.colors.textSecondary)
            } else {
              Text(file.content)
                .font(.mono(Theme.codeSize))
                .foregroundStyle(theme.colors.textPrimary)
                .textSelection(.enabled)
                .accessibilityIdentifier("chat.document.text")
              if file.truncated {
                Text("Only the beginning of the file is shown.")
                  .font(.geist(Theme.text.xs, relativeTo: .caption))
                  .foregroundStyle(theme.colors.textTertiary)
              }
            }
          } else {
            ProgressView().frame(maxWidth: .infinity)
          }
        }
        .padding(Theme.gutter)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(theme.colors.surface0)
    .task {
      do {
        file = try await open(card)
      } catch {
        failure = (error as? ServerError)?.message ?? String(describing: error)
      }
    }
  }
}

// MARK: - Permissions

/// A permission the agent asked for: what, the options, the questions; or how it was settled.
struct PermissionCardView: View {
  let card: PermissionCard
  let answer: @MainActor (PermissionCard, String, [String: String]?) async -> Void
  /// The canonical keys of the questions whose answers are secrets.
  var secretKeys: Set<String> = []

  @Environment(\.claveTheme) private var theme
  @State private var replies: [String: QuestionReply] = [:]
  @State private var problem: String?
  @State private var busy = false

  var body: some View {
    let request = card.request
    let described = describeApproval(request)
    Card {
      VStack(alignment: .leading, spacing: Theme.space(2.5)) {
        HStack(alignment: .firstTextBaseline, spacing: Theme.space(2)) {
          Icon(isQuestion(request) ? .questionMarkCircle : .shieldCheck, size: Theme.chatGlyph)
            .foregroundStyle(card.isOpen ? theme.colors.statusWaiting : theme.colors.textTertiary)
          VStack(alignment: .leading, spacing: Theme.space(0.5)) {
            Text(described?.label ?? request.description)
              .font(.geist(Theme.text.sm, weight: .semibold, relativeTo: .body))
              .foregroundStyle(theme.colors.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
            if let tool = request.toolName, !tool.isEmpty, described == nil {
              Text(tool)
                .font(.mono(Theme.text.xs))
                .foregroundStyle(theme.colors.textTertiary)
            }
          }
        }
        if let target = described?.target, !target.isEmpty {
          Text(target)
            .font(.mono(Theme.codeSize))
            .foregroundStyle(theme.colors.textSecondary)
            .textSelection(.enabled)
        } else if described != nil, !request.description.isEmpty {
          Text(request.description)
            .font(.geist(Theme.text.sm, weight: .regular, relativeTo: .body))
            .foregroundStyle(theme.colors.textSecondary)
        }
        if let detail = request.detail, !detail.isEmpty {
          Text(detail)
            .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
            .foregroundStyle(theme.colors.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if card.isOpen {
          if let questions = request.questions, !questions.isEmpty {
            QuestionForm(requestId: request.id, questions: questions, secretKeys: secretKeys, replies: $replies)
          }
          if let problem {
            Text(problem)
              .font(.geist(Theme.text.xs, relativeTo: .caption))
              .foregroundStyle(theme.colors.destructive)
          }
          FlowRow(spacing: Theme.space(2)) {
            ForEach(request.options, id: \.id) { option in
              Button(option.label) {
                Task { await choose(option.id) }
              }
              .buttonStyle(.clave(isRefusalOption(option) ? .secondary : .primary, size: .small))
              .disabled(busy)
              .accessibilityIdentifier("chat.permission.\(request.id).\(option.id)")
            }
          }
        } else {
          Text(settledWords)
            .font(.geist(Theme.text.xs, relativeTo: .caption))
            .foregroundStyle(theme.colors.textTertiary)
            .accessibilityIdentifier("chat.permission.\(request.id).state")
        }
      }
    }
    .overlay {
      if card.isOpen {
        RoundedRectangle(cornerRadius: Theme.radius.lg, style: .continuous)
          .strokeBorder(theme.colors.statusWaiting.opacity(0.6), lineWidth: 1)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.permission.\(request.id)")
  }

  /// How a settled card reads: the reader's own word, or who settled it.
  private var settledWords: String {
    switch card.state {
    case .pending: return "Waiting for you"
    case .answered(let optionId): return decisionWord(card.request, optionId)
    case .answeredElsewhere: return "Answered elsewhere"
    case .withdrawn: return "Withdrawn by the agent"
    }
  }

  private func choose(_ optionId: String) async {
    problem = nil
    var answers: [String: String]?
    if let questions = card.request.questions, !questions.isEmpty, optionId == "answer" {
      switch shapeAnswers(questions, replies) {
      case .success(let shaped): answers = shaped
      case .failure(let failure):
        problem = failure.message
        return
      }
    }
    busy = true
    await answer(card, optionId, answers)
    busy = false
  }
}

// MARK: - Errors

struct ErrorItemView: View {
  let item: ErrorItem

  @Environment(\.claveTheme) private var theme

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.space(2)) {
      Icon(.exclamationTriangle, size: Theme.chatGlyph)
      Text(item.message)
        .font(.geist(Theme.text.sm, weight: .regular, relativeTo: .body))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(theme.colors.destructive)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error, \(item.message)")
    .accessibilityIdentifier("chat.error.\(item.ordinal)")
  }
}
