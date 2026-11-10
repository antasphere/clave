import ClaveCore
import SwiftUI
import UIKit

// The assistant's prose as the desktop's chat view draws it: GitHub-flavoured blocks on the
// ground, inline text through Foundation's Markdown reader in Geist, fenced code in a scrolling
// monospaced box coloured by the core's highlighter, tables as a grid. The blocks are mapped to
// `RenderedBlock` first so the mapping is testable without drawing anything.

/// One block ready to draw: the inline Markdown already turned into styled text.
indirect enum RenderedBlock: Equatable {
  /// A paragraph (level nil) or a heading of level 1 to 6.
  case text(AttributedString, heading: Int?)
  case code(language: String?, text: AttributedString)
  case table(header: [AttributedString], alignments: [MarkdownAlignment], rows: [[AttributedString]])
  case list(ordered: Bool, start: Int, items: [[RenderedBlock]])
  case quote([RenderedBlock])
  case image(url: URL?, alt: String)
  case rule
  /// Raw HTML is shown as its source: the phone renders no markup it did not parse.
  case raw(String)
}

/// The two code palettes, GitHub light and GitHub dark, as the desktop's Shiki themes draw them.
nonisolated func codeColor(_ kind: CodeTokenKind, _ palette: CodePalette) -> Color {
  func hex(_ value: UInt32) -> Color {
    Color(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
  }
  switch (palette, kind) {
  case (.dark, .plain): return hex(0xE6EDF3)
  case (.dark, .keyword): return hex(0xFF7B72)
  case (.dark, .string): return hex(0xA5D6FF)
  case (.dark, .comment): return hex(0x8B949E)
  case (.dark, .number): return hex(0x79C0FF)
  case (.dark, .inserted): return hex(0x7EE787)
  case (.dark, .deleted): return hex(0xFFA198)
  case (.dark, .meta): return hex(0xD2A8FF)
  case (.light, .plain): return hex(0x1F2328)
  case (.light, .keyword): return hex(0xCF222E)
  case (.light, .string): return hex(0x0A3069)
  case (.light, .comment): return hex(0x6E7781)
  case (.light, .number): return hex(0x0550AE)
  case (.light, .inserted): return hex(0x116329)
  case (.light, .deleted): return hex(0x82071E)
  case (.light, .meta): return hex(0x8250DF)
  }
}

/// Maps parsed Markdown to drawable blocks under one theme and one text size.
struct MarkdownRenderer {
  let theme: Theme
  var size: CGFloat = Theme.text.sm

  func render(_ markdown: String) -> [RenderedBlock] {
    render(parseMarkdown(markdown))
  }

  func render(_ blocks: [MarkdownBlock]) -> [RenderedBlock] {
    blocks.map(render)
  }

  private func render(_ block: MarkdownBlock) -> RenderedBlock {
    switch block {
    case .paragraph(let inline):
      return .text(self.inline(inline), heading: nil)
    case .heading(let level, let inline):
      return .text(self.inline(inline, size: headingSize(level), weight: .semibold), heading: level)
    case .code(let language, let text):
      return .code(language: language, text: code(text, language: language))
    case .table(let header, let alignments, let rows):
      return .table(
        header: header.map { self.inline($0, weight: .semibold) },
        alignments: alignments,
        rows: rows.map { row in row.map { self.inline($0) } })
    case .list(let ordered, let start, let items):
      return .list(ordered: ordered, start: start, items: items.map(render))
    case .quote(let blocks):
      return .quote(render(blocks))
    case .image(let url, let alt):
      return .image(url: URL(string: url), alt: alt)
    case .rule:
      return .rule
    case .html(let raw):
      return .raw(raw)
    }
  }

  private func headingSize(_ level: Int) -> CGFloat {
    switch level {
    case 1: Theme.text.lg + 2
    case 2: Theme.text.lg
    case 3: Theme.text.base
    default: size
    }
  }

  /// Inline Markdown as styled text: strong in SemiBold, code spans monospaced on a tint, links in
  /// the accent. Text that does not parse is shown as it came.
  func inline(_ markdown: String, size: CGFloat? = nil, weight: GeistWeight = .medium) -> AttributedString {
    let size = size ?? self.size
    let options = AttributedString.MarkdownParsingOptions(
      allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    var text = (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)
    text.font = .geist(size, weight: weight, relativeTo: .body)
    text.foregroundColor = theme.colors.textPrimary
    for run in text.runs {
      let intent = run.inlinePresentationIntent ?? []
      if intent.contains(.code) {
        text[run.range].font = .mono(Theme.codeSize)
        text[run.range].backgroundColor = theme.colors.surface200
      } else if intent.contains(.stronglyEmphasized) {
        text[run.range].font = .geist(size, weight: .semibold, relativeTo: .body)
      }
      if intent.contains(.strikethrough) {
        text[run.range].strikethroughStyle = .single
      }
      if run.link != nil {
        text[run.range].foregroundColor = theme.colors.accent
        text[run.range].underlineStyle = .single
      }
    }
    return text
  }

  /// A fenced block in the highlighter's tokens, plain when its language is unknown.
  func code(_ source: String, language: String?) -> AttributedString {
    let palette = CodePalette(theme: theme.name.rawValue)
    var out = AttributedString()
    if let lines = highlightCode(source, language: language) {
      for (index, line) in lines.enumerated() {
        if index > 0 { out.append(AttributedString("\n")) }
        for token in line {
          var piece = AttributedString(token.text)
          piece.foregroundColor = codeColor(token.kind, palette)
          out.append(piece)
        }
      }
    } else {
      var plain = AttributedString(source)
      plain.foregroundColor = codeColor(.plain, palette)
      out = plain
    }
    out.font = .mono(Theme.codeSize)
    return out
  }
}

/// The assistant's Markdown, drawn.
struct MarkdownView: View {
  let text: String

  @Environment(\.claveTheme) private var theme

  var body: some View {
    MarkdownBlocksView(blocks: MarkdownRenderer(theme: theme).render(text))
      .environment(\.openURL, OpenURLAction { url in
        // Only web links leave the app; any other scheme in an agent's text is not followed.
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || scheme == "http" || scheme == "mailto" ? .systemAction : .discarded
      })
  }
}

/// A column of drawn blocks.
struct MarkdownBlocksView: View {
  let blocks: [RenderedBlock]

  var body: some View {
    VStack(alignment: .leading, spacing: Theme.space(3)) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        RenderedBlockView(block: block)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct RenderedBlockView: View {
  let block: RenderedBlock

  @Environment(\.claveTheme) private var theme
  @ScaledMetric(relativeTo: .body) private var bulletWidth: CGFloat = 18

  var body: some View {
    switch block {
    case .text(let text, let heading):
      Text(text)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(heading == nil ? [] : .isHeader)
    case .code(let language, let text):
      CodeBlockView(language: language, text: text)
    case .table(let header, let alignments, let rows):
      TableBlockView(header: header, alignments: alignments, rows: rows)
    case .list(let ordered, let start, let items):
      VStack(alignment: .leading, spacing: Theme.space(1.5)) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .firstTextBaseline, spacing: Theme.space(1.5)) {
            Text(ordered ? "\(start + index)." : "•")
              .font(.geist(Theme.text.sm, relativeTo: .body))
              .foregroundStyle(theme.colors.textSecondary)
              .frame(minWidth: bulletWidth, alignment: .trailing)
              .accessibilityHidden(!ordered)
            // A nested list is a block of the item: the recursion goes through a type-erased view.
            AnyView(MarkdownBlocksView(blocks: item))
          }
        }
      }
    case .quote(let blocks):
      HStack(alignment: .top, spacing: Theme.space(3)) {
        Rectangle().fill(theme.colors.border).frame(width: 2)
        AnyView(MarkdownBlocksView(blocks: blocks))
          .foregroundStyle(theme.colors.textSecondary)
      }
      .fixedSize(horizontal: false, vertical: true)
    case .image(let url, let alt):
      VStack(alignment: .leading, spacing: Theme.space(1)) {
        AsyncImage(url: url) { phase in
          switch phase {
          case .success(let image):
            image.resizable().scaledToFit()
          case .failure:
            Icon(.photo, size: 24).foregroundStyle(theme.colors.textTertiary)
          default:
            ProgressView()
          }
        }
        .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius.lg, style: .continuous))
        .accessibilityLabel(alt.isEmpty ? "Image" : alt)
        .accessibilityIdentifier("chat.markdown.image")
        if !alt.isEmpty {
          Text(alt)
            .font(.geist(Theme.text.xs, relativeTo: .caption))
            .foregroundStyle(theme.colors.textTertiary)
            .accessibilityHidden(true)
        }
      }
    case .rule:
      Rectangle().fill(theme.colors.borderSubtle).frame(height: 1)
        .accessibilityHidden(true)
    case .raw(let source):
      Text(source)
        .font(.mono(Theme.codeSize))
        .foregroundStyle(theme.colors.textSecondary)
    }
  }
}

/// `pre`: a box on surface-50 that scrolls sideways rather than wrapping a code line.
struct CodeBlockView: View {
  let language: String?
  let text: AttributedString

  @Environment(\.claveTheme) private var theme

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius.lg, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      if let language, !language.isEmpty {
        Text(language)
          .font(.geist(Theme.text.meta, relativeTo: .caption2))
          .foregroundStyle(theme.colors.textTertiary)
          .padding(.horizontal, Theme.space(3))
          .padding(.top, Theme.space(2))
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(text)
          .fixedSize(horizontal: true, vertical: true)
          .padding(Theme.space(3))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(shape.fill(theme.colors.surface50))
    .overlay(shape.strokeBorder(theme.colors.borderSubtle, lineWidth: 1))
    .contextMenu {
      Button("Copy code") { UIPasteboard.general.string = String(text.characters) }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(language.map { "Code, \($0)" } ?? "Code")
    .accessibilityValue(String(text.characters))
    .accessibilityIdentifier("chat.markdown.code")
  }
}

/// A GFM table: the header row bold over a hairline, scrolling sideways when wider than the column.
struct TableBlockView: View {
  let header: [AttributedString]
  let alignments: [MarkdownAlignment]
  let rows: [[AttributedString]]

  @Environment(\.claveTheme) private var theme

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: Theme.space(4), verticalSpacing: Theme.space(2)) {
        GridRow {
          ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
            Text(cell).gridColumnAlignment(alignment(column))
          }
        }
        .accessibilityAddTraits(.isHeader)
        Rectangle().fill(theme.colors.border).frame(height: 1).gridCellUnsizedAxes(.horizontal)
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(cell)
            }
          }
        }
      }
      .padding(.vertical, Theme.space(1))
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chat.markdown.table")
  }

  private func alignment(_ column: Int) -> HorizontalAlignment {
    switch alignments.indices.contains(column) ? alignments[column] : .none {
    case .center: .center
    case .right: .trailing
    case .left, .none: .leading
    }
  }
}
