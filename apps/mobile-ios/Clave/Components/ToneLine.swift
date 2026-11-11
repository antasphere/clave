import SwiftUI

/// A sentence that reports an error, a failure or a warning: its words in textPrimary, readable on
/// every surface of every theme, and the tone's shared ink on the glyph at their leading side,
/// hidden from VoiceOver because the words already say it. The shared semantic inks read below
/// 4.5:1 as text on most surfaces of the light, coffee and charcoal themes (ContrastTests).
struct ToneLine: View {
  enum Tone { case error, warning }

  let text: String
  let tone: Tone
  let size: CGFloat
  let textStyle: Font.TextStyle
  let alignment: TextAlignment

  @Environment(\.claveTheme) private var theme
  @ScaledMetric private var glyph: CGFloat

  init(
    _ text: String, tone: Tone, size: CGFloat = Theme.text.xs, textStyle: Font.TextStyle = .caption,
    alignment: TextAlignment = .leading
  ) {
    self.text = text
    self.tone = tone
    self.size = size
    self.textStyle = textStyle
    self.alignment = alignment
    _glyph = ScaledMetric(wrappedValue: size, relativeTo: textStyle)
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.space(1.5)) {
      Icon(.exclamationTriangle, size: glyph)
        .foregroundStyle(tone == .error ? theme.colors.destructive : theme.colors.warning)
      Text(text)
        .font(.geist(size, relativeTo: textStyle))
        .foregroundStyle(theme.colors.textPrimary)
        .multilineTextAlignment(alignment)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}
