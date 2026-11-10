import SwiftUI
import UIKit

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

/// The height of `lines` lines of Geist at the scaled `size`, with a text view's own top and bottom
/// insets: the most a growing field shows before it scrolls.
func growingFieldHeight(lines: Int, size: CGFloat, weight: GeistWeight) -> CGFloat {
  let line = UIFont(name: weight.fontName, size: size)?.lineHeight ?? size * 1.25
  return line * CGFloat(lines) + 16
}

/// What an empty growing field says, where a text view draws its first line; drawn only, the
/// field's own label is what VoiceOver reads.
struct GrowingFieldPrompt: View {
  let text: String
  let size: CGFloat
  let weight: GeistWeight

  @Environment(\.claveTheme) private var theme

  init(_ text: String, size: CGFloat, weight: GeistWeight) {
    self.text = text
    self.size = size
    self.weight = weight
  }

  var body: some View {
    Text(text)
      .font(.geist(size, weight: weight, relativeTo: .body))
      .foregroundStyle(theme.colors.textTertiary)
      // A text view's text container: 8 points from the top, a 5-point line fragment padding.
      .padding(.top, 8)
      .padding(.leading, 5)
      // Its whole height counts in the field's, so a long prompt at a large text size is never cut.
      .fixedSize(horizontal: false, vertical: true)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}
