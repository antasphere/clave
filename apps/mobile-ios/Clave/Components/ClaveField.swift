import SwiftUI

/// `.input-field`: the field metrics on surface-50, the border taking the
/// accent while the field has focus.
struct ClaveField: View {
  let placeholder: String
  @Binding var text: String
  var label: String?

  @Environment(\.claveTheme) private var theme
  @FocusState private var focused: Bool

  init(_ placeholder: String, text: Binding<String>, label: String? = nil) {
    self.placeholder = placeholder
    _text = text
    self.label = label
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.field.radius, style: .continuous)
    TextField(
      label ?? placeholder,
      text: $text,
      prompt: Text(placeholder).foregroundStyle(theme.colors.textTertiary)
    )
    .font(.geist(Theme.field.text, relativeTo: .body))
    .foregroundStyle(theme.colors.textPrimary)
    .focused($focused)
    .padding(.horizontal, Theme.field.px)
    .padding(.vertical, Theme.space(2))
    .frame(minHeight: max(Theme.field.h, 44))
    .background(shape.fill(theme.colors.surface50))
    .overlay(shape.strokeBorder(focused ? theme.colors.accent : theme.colors.border, lineWidth: 1))
    .contentShape(shape)
    // The padding is part of the field to the eye, so a tap on it must focus too.
    .simultaneousGesture(TapGesture().onEnded { focused = true })
  }
}
