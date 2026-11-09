import ClaveCore
import SwiftUI

/// How a permission's buttons are laid out: the refusals at the left beside Dismiss, the allowing
/// options at the right, the first of them the primary one.
nonisolated struct PermissionButtonGroups: Equatable, Sendable {
  let refusals: [PermissionOption]
  let allows: [PermissionOption]

  var primaryId: String? { allows.first?.id }

  init(_ request: PendingRequest) {
    let options = request.options ?? []
    refusals = options.filter(isRefusalOption)
    allows = options.filter { !isRefusalOption($0) }
  }
}

/// The words a request's kind shows in its card's kicker.
nonisolated func requestKindWord(_ kind: RequestKind) -> String {
  switch kind {
  case .permission: "Permission"
  case .clarification: "Question"
  case .secret: "Secret"
  }
}

/// What waits for the person on a machine: tools to allow, questions to answer, secrets to give.
struct RequestsScreen: View {
  let model: AppModel
  let machineId: String

  var body: some View {
    ConnectionView(model: model, machineId: machineId) { connection in
      RequestsContent(connection: connection)
    }
  }
}

private struct RequestsContent: View {
  let connection: MachineConnection

  @Environment(\.claveTheme) private var theme
  /// A sentence per card: a refusal of the server, or the word that someone else answered first.
  @State private var notices: [String: String] = [:]
  /// Requests another device settled first, kept on screen with their notice until a refresh.
  @State private var settled: [PendingRequest] = []

  private var shown: [PendingRequest] {
    let live = Set(connection.requests.map(\.id))
    return (connection.requests + settled.filter { !live.contains($0.id) }).sorted { $0.createdAt < $1.createdAt }
  }

  var body: some View {
    VStack(spacing: 0) {
      PaneHeader("Requests", subtitle: connection.name)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: Theme.space(3)) {
          if connection.requestsUnavailable {
            NoticeRow(text: "This server keeps no request list. Answer the agent's questions in its chat.", tone: .warning)
              .accessibilityIdentifier("requests.unavailable")
          } else if let error = connection.lastError {
            NoticeRow(text: error, tone: .error)
              .accessibilityIdentifier("requests.error")
          }
          let requests = shown
          if requests.isEmpty && !connection.requestsUnavailable {
            EmptyState(icon: .inboxStack, title: "Nothing is waiting for you", text: "A tool to allow or a question to answer lands here.")
              .padding(.top, Theme.space(10))
              .accessibilityIdentifier("requests.empty")
          }
          let live = Set(connection.requests.map(\.id))
          ForEach(requests) { request in
            RequestCard(
              request: request,
              sessionTitle: connection.sessions.first { $0.id == request.sessionId }.flatMap { $0.title.isEmpty ? nil : $0.title },
              notice: notices[request.id],
              isSettled: !live.contains(request.id),
              resolve: { response in await resolve(request, response) })
          }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, Theme.space(4))
      }
      .refreshable {
        settled = []
        notices = [:]
        await connection.reloadRequests()
      }
    }
  }

  private func resolve(_ request: PendingRequest, _ response: RequestResponse) async {
    notices[request.id] = nil
    do {
      // One request: a refusal of the device's scope is shown and never retried.
      let outcome = try await connection.resolve(requestId: request.id, response: response)
      if !outcome.accepted {
        notices[request.id] = "Answered elsewhere first: this request is settled."
        if !settled.contains(where: { $0.id == request.id }) { settled.append(request) }
      }
    } catch let error as ServerError {
      notices[request.id] = error.message
    } catch {
      notices[request.id] = "The answer could not be sent."
    }
  }
}

/// One pending request, as the chat's permission card draws one: what is asked, the form, the answers.
struct RequestCard: View {
  let request: PendingRequest
  let sessionTitle: String?
  let notice: String?
  /// Answered elsewhere: the card stays to say so, without its form.
  let isSettled: Bool
  let resolve: (RequestResponse) async -> Void

  @Environment(\.claveTheme) private var theme
  @State private var replies: [String: QuestionReply] = [:]
  @State private var secret = ""
  @State private var revealed = false
  @State private var problem: String?
  @State private var busy = false

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius.xxl, style: .continuous)
    VStack(alignment: .leading, spacing: Theme.space(2.5)) {
      Text([requestKindWord(request.kind), sessionTitle, request.toolName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
        .foregroundStyle(theme.colors.textTertiary)
        .lineLimit(2)
      Text(request.description)
        .font(.geist(Theme.text.control, relativeTo: .body))
        .foregroundStyle(theme.colors.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      if let detail = request.detail, !detail.isEmpty {
        Text(detail)
          .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
          .foregroundStyle(theme.colors.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let notice {
        Text(notice)
          .font(.geist(Theme.text.xs, relativeTo: .caption))
          .foregroundStyle(theme.colors.warning)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("requests.notice.\(request.id)")
      }
      if !isSettled {
        if request.kind == .secret {
          secretForm
        } else {
          answerForm
        }
      }
    }
    .padding(.horizontal, Theme.space(3.5))
    .padding(.vertical, Theme.space(3))
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(shape.fill(theme.colors.surfaceRaised))
    .overlay(shape.strokeBorder(theme.colors.borderSubtle, lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("requests.card.\(request.id)")
  }

  // MARK: a secret

  @ViewBuilder
  private var secretForm: some View {
    if let action = request.action {
      Text(actionLine(action))
        .font(.mono(Theme.codeSize))
        .foregroundStyle(theme.colors.textSecondary)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
    let shape = RoundedRectangle(cornerRadius: Theme.field.radius, style: .continuous)
    HStack(spacing: Theme.space(1)) {
      Group {
        if revealed {
          TextField("The secret", text: $secret, prompt: Text("Stays on the phone until you send it").foregroundStyle(theme.colors.textTertiary))
        } else {
          SecureField("The secret", text: $secret, prompt: Text("Stays on the phone until you send it").foregroundStyle(theme.colors.textTertiary))
        }
      }
      .font(.geist(Theme.field.text, relativeTo: .body))
      .foregroundStyle(theme.colors.textPrimary)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .accessibilityLabel("The secret")
      .accessibilityIdentifier("requests.secret.\(request.id)")
      Button {
        revealed.toggle()
      } label: {
        Icon(revealed ? .eyeSlash : .eye, size: Theme.control.icon)
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(theme.colors.textSecondary)
      .accessibilityLabel(revealed ? "Hide the secret" : "Show the secret")
      .accessibilityIdentifier("requests.secret.toggle.\(request.id)")
    }
    .padding(.leading, Theme.field.px)
    .frame(minHeight: max(Theme.field.h, 44))
    .background(shape.fill(theme.colors.surface50))
    .overlay(shape.strokeBorder(theme.colors.border, lineWidth: 1))
    problemLine
    HStack(spacing: Theme.space(2)) {
      dismissButton
      Spacer(minLength: 0)
      Button("Send the secret") { send(shapeSecret(secret)) }
        .buttonStyle(.clave(.primary, size: .small))
        .disabled(busy)
        .accessibilityIdentifier("requests.secret.send.\(request.id)")
    }
  }

  private func actionLine(_ action: SecretAction) -> String {
    switch action {
    case .run(let command, _, let envVar): "Used as \(envVar) by: \(command)"
    case .envFile(let file, let key): "Written to \(file) as \(key)"
    }
  }

  // MARK: a permission or a question

  @ViewBuilder
  private var answerForm: some View {
    if let questions = request.questions, !questions.isEmpty {
      QuestionForm(
        requestId: request.id, questions: questions, secretKeys: Set(request.secretQuestions ?? []), replies: $replies)
    }
    problemLine
    if answersAsPermission(request) {
      let groups = PermissionButtonGroups(request)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Theme.space(2)) {
          permissionButtons(groups, spaced: true)
        }
        FlowRow(spacing: Theme.space(2)) {
          permissionButtons(groups, spaced: false)
        }
      }
    } else {
      HStack(spacing: Theme.space(2)) {
        dismissButton
        Spacer(minLength: 0)
        Button("Answer") { send(shapeClarification(request, replies: replies)) }
          .buttonStyle(.clave(.primary, size: .small))
          .disabled(busy)
          .accessibilityIdentifier("requests.answer.\(request.id)")
      }
    }
  }

  @ViewBuilder
  private func permissionButtons(_ groups: PermissionButtonGroups, spaced: Bool) -> some View {
    ForEach(groups.refusals) { option in optionButton(option, role: .secondary) }
    dismissButton
    if spaced { Spacer(minLength: 0) }
    ForEach(groups.allows) { option in
      optionButton(option, role: option.id == groups.primaryId ? .primary : .secondary)
    }
  }

  private func optionButton(_ option: PermissionOption, role: ClaveButtonStyle.Role) -> some View {
    Button(option.label) { send(shapePermission(request, optionId: option.id, replies: replies)) }
      .buttonStyle(.clave(role, size: .small))
      .disabled(busy)
      .accessibilityIdentifier("requests.option.\(request.id).\(option.id)")
  }

  private var dismissButton: some View {
    Button("Dismiss") { send(.response(dismissal)) }
      .buttonStyle(.clave(.secondary, size: .small))
      .disabled(busy)
      .accessibilityIdentifier("requests.dismiss.\(request.id)")
  }

  @ViewBuilder
  private var problemLine: some View {
    if let problem {
      Text(problem)
        .font(.geist(Theme.text.xs, relativeTo: .caption))
        .foregroundStyle(theme.colors.destructive)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("requests.problem.\(request.id)")
    }
  }

  // MARK: sending

  private func send(_ shaped: ShapedAnswer) {
    switch shaped {
    case .problem(let message):
      problem = message
    case .response(let response):
      if let invalid = validateResponse(request, response) {
        problem = invalid
        return
      }
      problem = nil
      busy = true
      Task {
        await resolve(response)
        busy = false
      }
    }
  }
}
