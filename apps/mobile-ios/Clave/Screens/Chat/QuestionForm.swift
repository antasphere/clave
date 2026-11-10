import ClaveCore
import SwiftUI
import UIKit

/// The questions a permission asks, as a form: each question's options to pick from (one, or
/// several when it allows it) and a free answer, masked when the request says the answer is a
/// secret. The replies are kept by the question's canonical key, the key the server reads.
struct QuestionForm: View {
  let requestId: String
  let questions: [AgentQuestion]
  /// The canonical keys whose answers are secrets.
  var secretKeys: Set<String> = []
  @Binding var replies: [String: QuestionReply]

  @Environment(\.claveTheme) private var theme
  @ScaledMetric(relativeTo: .body) private var answerSize: CGFloat = Theme.field.text

  var body: some View {
    VStack(alignment: .leading, spacing: Theme.space(4)) {
      ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
        questionView(question, index: index)
      }
    }
  }

  @ViewBuilder
  private func questionView(_ question: AgentQuestion, index: Int) -> some View {
    let key = questionKey(question)
    let multi = question.multiSelect == true
    VStack(alignment: .leading, spacing: Theme.space(2)) {
      if let header = question.header, !header.isEmpty {
        Text(header)
          .font(.geist(Theme.text.meta, relativeTo: .caption2))
          .textCase(.uppercase)
          .foregroundStyle(theme.colors.textTertiary)
      }
      Text(question.question)
        .font(.geist(Theme.text.sm, relativeTo: .body))
        .foregroundStyle(theme.colors.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
        let picked = replies[key]?.picked.contains(option.label) ?? false
        Button {
          toggle(option.label, key: key, multi: multi)
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: Theme.space(2)) {
            Image(systemName: multi ? (picked ? "checkmark.square.fill" : "square") : (picked ? "largecircle.fill.circle" : "circle"))
              .foregroundStyle(picked ? theme.colors.accent : theme.colors.textTertiary)
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.space(0.5)) {
              Text(option.label)
                .font(.geist(Theme.text.sm, relativeTo: .body))
                .foregroundStyle(theme.colors.textPrimary)
              if let description = option.description, !description.isEmpty {
                Text(description)
                  .font(.geist(Theme.text.xs, weight: .regular, relativeTo: .caption))
                  .foregroundStyle(theme.colors.textSecondary)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat.permission.\(requestId).question.\(index).option.\(optionIndex)")
        // The agent's own words may be a file name or a command: the label says which option it
        // is, the value says the words.
        .accessibilityLabel("Option \(optionIndex + 1) of \(question.options.count)")
        .accessibilityValue(option.label)
        .accessibilityHint(option.description ?? "")
        .accessibilityAddTraits(picked ? .isSelected : [])
      }
      answerField(key: key, index: index)
    }
  }

  @ViewBuilder
  private func answerField(key: String, index: Int) -> some View {
    let binding = Binding<String>(
      get: { replies[key]?.other ?? "" },
      set: { value in
        var reply = replies[key] ?? QuestionReply()
        reply.other = value
        replies[key] = reply
      })
    let shape = RoundedRectangle(cornerRadius: Theme.field.radius, style: .continuous)
    let identifier = "chat.permission.\(requestId).question.\(index).answer"
    Group {
      if secretKeys.contains(key) {
        SecureField("Answer", text: binding, prompt: Text("Answer").foregroundStyle(theme.colors.textTertiary))
          .frame(minHeight: 44)
          .accessibilityIdentifier(identifier)
      } else {
        // A text view rather than a growing text field: its own frame is the box a finger and
        // VoiceOver reach, from 44 points to eight lines, where it scrolls. The prompt is layered
        // over it while it is empty.
        ZStack(alignment: .topLeading) {
          TextEditor(text: binding)
            .scrollContentBackground(.hidden)
            .accessibilityLabel("Answer")
            .accessibilityIdentifier(identifier)
            .frame(minHeight: 44, maxHeight: growingFieldHeight(lines: 8, size: answerSize, weight: .medium))
            .fixedSize(horizontal: false, vertical: true)
          if binding.wrappedValue.isEmpty {
            GrowingFieldPrompt("Your own answer", size: Theme.field.text, weight: .medium)
          }
        }
      }
    }
    .font(.geist(Theme.field.text, relativeTo: .body))
    .foregroundStyle(theme.colors.textPrimary)
    .padding(.horizontal, Theme.field.px)
    .background(shape.fill(theme.colors.surface50))
    .overlay(shape.strokeBorder(theme.colors.border, lineWidth: 1))
  }

  private func toggle(_ label: String, key: String, multi: Bool) {
    var reply = replies[key] ?? QuestionReply()
    if multi {
      if let at = reply.picked.firstIndex(of: label) { reply.picked.remove(at: at) } else { reply.picked.append(label) }
    } else {
      reply.picked = reply.picked == [label] ? [] : [label]
    }
    replies[key] = reply
  }
}
