import Foundation

// The assistant's Markdown, cut into GitHub-flavoured blocks for the screen.
// The prototype (`apps/mobile/src/chat/markdown.ts`) parses with remark and
// remark-gfm, the desktop's own pipeline; the phone has no such library in
// Foundation, so the block structure is parsed here by hand and the inline
// text of every block is left as Markdown for the screen's
// `AttributedString(markdown:)`, which already reads emphasis, code spans,
// links and strikethrough. What markdown.ts adds on top of remark is ported:
// reference links and images resolve case-insensitively against their
// definitions, the first definition winning. An unfinished fence stays code,
// so an answer that is still streaming reads as code as it grows.

/// A table column's alignment, from the delimiter row.
public enum MarkdownAlignment: Sendable, Equatable {
  case none, left, center, right
}

/// One block of a Markdown text. Inline text is Markdown still (soft breaks joined with a space,
/// hard breaks kept as a newline, reference links resolved to inline ones).
public indirect enum MarkdownBlock: Sendable, Equatable {
  case paragraph(inline: String)
  case heading(level: Int, inline: String)
  /// A fenced or indented block; the language is the fence's first word.
  case code(language: String?, text: String)
  case table(header: [String], alignments: [MarkdownAlignment], rows: [[String]])
  /// Each item is its own blocks; a nested list is a list block inside an item.
  case list(ordered: Bool, start: Int, items: [[MarkdownBlock]])
  case quote([MarkdownBlock])
  /// An image standing alone on its line(s).
  case image(url: String, alt: String)
  case rule
  case html(raw: String)
}

/// The blocks of a Markdown text.
public func parseMarkdown(_ text: String) -> [MarkdownBlock] {
  let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
  var lines = normalized.components(separatedBy: "\n").map(expandLeadingTabs)
  let definitions = extractDefinitions(&lines)
  var parser = BlockParser(definitions: definitions)
  return parser.blocks(lines)
}

// MARK: - Lines

private func expandLeadingTabs(_ line: String) -> String {
  guard line.contains("\t") else { return line }
  var out = ""
  var column = 0
  var rest = Substring(line)
  while let c = rest.first, c == " " || c == "\t" {
    if c == "\t" {
      let width = 4 - column % 4
      out += String(repeating: " ", count: width)
      column += width
    } else {
      out += " "
      column += 1
    }
    rest = rest.dropFirst()
  }
  return out + rest
}

private func isBlank(_ line: String) -> Bool { line.allSatisfy { $0 == " " || $0 == "\t" } }

private func indentOf(_ line: String) -> Int { line.prefix(while: { $0 == " " }).count }

private func dropSpaces(_ line: String, _ count: Int) -> String {
  String(line.dropFirst(min(count, indentOf(line))))
}

private func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }

private func groups(_ regex: NSRegularExpression, _ text: String) -> [String?]? {
  let ns = text as NSString
  guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
  return (0..<match.numberOfRanges).map { index in
    let range = match.range(at: index)
    return range.location == NSNotFound ? nil : ns.substring(with: range)
  }
}

private let definitionPattern = regex("^ {0,3}\\[([^\\]]+)\\]:[ \\t]*<?([^\\s>]+)>?(?:[ \\t]+(?:\"[^\"]*\"|'[^']*'|\\([^)]*\\)))?[ \\t]*$")
private let fenceOpen = regex("^ {0,3}(`{3,}|~{3,})(.*)$")
private let atxHeading = regex("^ {0,3}(#{1,6})(?:[ \\t]+(.*?))?(?:[ \\t]+#+)?[ \\t]*$")
private let thematicBreak = regex("^ {0,3}(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$")
private let setextOne = regex("^ {0,3}=+[ \\t]*$")
private let setextTwo = regex("^ {0,3}-+[ \\t]*$")
private let listMarker = regex("^( {0,3})([-+*]|(\\d{1,9})([.)]))( +|$)(.*)$")
private let quoteMarker = regex("^ {0,3}> ?(.*)$")
private let htmlStart = regex("^ {0,3}<(?:!--|/?[A-Za-z][A-Za-z0-9-]*(?:[ \\t>]|/>|$))")
private let delimiterCell = regex("^[ \\t]*(:?)-+(:?)[ \\t]*$")
private let soloImage = regex("^!\\[([^\\]]*)\\]\\([ \\t]*<?([^\\s>)]+)>?(?:[ \\t]+\"[^\"]*\")?[ \\t]*\\)$")

/// Link reference definitions, keyed by their upper-cased label, the first one winning; their lines
/// are taken out of the text, as they render nowhere. Lines inside a fence are left alone.
private func extractDefinitions(_ lines: inout [String]) -> [String: String] {
  var definitions: [String: String] = [:]
  var kept: [String] = []
  var fence: (Character, Int)?
  for line in lines {
    if let open = fence {
      kept.append(line)
      if closesFence(line, open) { fence = nil }
      continue
    }
    if let parts = groups(fenceOpen, line), let marker = parts[1] {
      fence = (marker.first!, marker.count)
      kept.append(line)
      continue
    }
    if let parts = groups(definitionPattern, line), let label = parts[1], let url = parts[2] {
      let key = normalizeLabel(label)
      if definitions[key] == nil { definitions[key] = url }
      continue
    }
    kept.append(line)
  }
  lines = kept
  return definitions
}

private func normalizeLabel(_ label: String) -> String {
  label.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").uppercased()
}

private func closesFence(_ line: String, _ open: (Character, Int)) -> Bool {
  guard indentOf(line) <= 3 else { return false }
  let body = line.trimmingCharacters(in: .whitespaces)
  return body.count >= open.1 && body.allSatisfy { $0 == open.0 }
}

private struct ListMarker {
  let ordered: Bool
  let delimiter: Character
  let number: Int
  let contentOffset: Int
  let content: String
}

private func listMarkerOf(_ line: String) -> ListMarker? {
  guard let parts = groups(listMarker, line), let marker = parts[2], let spaces = parts[5], let content = parts[6] else { return nil }
  let indent = parts[1]?.count ?? 0
  let ordered = parts[3] != nil
  let delimiter: Character = ordered ? Character(parts[4]!) : marker.first!
  // Five or more spaces after the marker make the content indented code: the content starts one space in.
  let gap = content.isEmpty || spaces.count >= 5 ? 1 : spaces.count
  let body = spaces.count >= 5 ? String(repeating: " ", count: spaces.count - 1) + content : content
  return ListMarker(ordered: ordered, delimiter: delimiter, number: Int(parts[3] ?? "1") ?? 1, contentOffset: indent + marker.count + gap, content: body)
}

private func isBlockStart(_ line: String) -> Bool {
  groups(fenceOpen, line) != nil || groups(atxHeading, line) != nil || groups(thematicBreak, line) != nil
    || groups(quoteMarker, line) != nil || listMarkerOf(line) != nil || groups(htmlStart, line) != nil
}

// MARK: - Tables

private func splitRow(_ line: String) -> [String] {
  var text = line.trimmingCharacters(in: .whitespaces)
  if text.hasPrefix("|") { text.removeFirst() }
  if text.hasSuffix("|") && !text.hasSuffix("\\|") { text.removeLast() }
  var cells: [String] = []
  var cell = ""
  var inCode = 0
  var escaped = false
  var index = text.startIndex
  while index < text.endIndex {
    let c = text[index]
    if escaped {
      // `\|` stays a pipe inside the cell; any other escape is the inline Markdown's to read.
      cell += c == "|" ? "|" : "\\\(c)"
      escaped = false
    } else if c == "\\" {
      escaped = true
    } else if c == "`" {
      var run = 0
      var probe = index
      while probe < text.endIndex, text[probe] == "`" { run += 1; probe = text.index(after: probe) }
      if inCode == 0 { inCode = run } else if inCode == run { inCode = 0 }
      cell += String(repeating: "`", count: run)
      index = probe
      continue
    } else if c == "|" && inCode == 0 {
      cells.append(cell.trimmingCharacters(in: .whitespaces))
      cell = ""
    } else {
      cell.append(c)
    }
    index = text.index(after: index)
  }
  if escaped { cell += "\\" }
  cells.append(cell.trimmingCharacters(in: .whitespaces))
  return cells
}

private func delimiterRow(_ line: String) -> [MarkdownAlignment]? {
  guard line.contains("-"), indentOf(line) < 4 else { return nil }
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  guard trimmed.contains("|") || trimmed.contains(":") || trimmed.allSatisfy({ $0 == "-" }) else { return nil }
  var alignments: [MarkdownAlignment] = []
  for cell in splitRow(line) {
    guard let parts = groups(delimiterCell, cell) else { return nil }
    let left = parts[1] == ":"
    let right = parts[2] == ":"
    alignments.append(left && right ? .center : left ? .left : right ? .right : .none)
  }
  return alignments
}

// MARK: - Blocks

private struct BlockParser {
  let definitions: [String: String]

  mutating func blocks(_ lines: [String]) -> [MarkdownBlock] {
    var out: [MarkdownBlock] = []
    var paragraph: [String] = []
    var i = 0
    func flush() {
      guard !paragraph.isEmpty else { return }
      out.append(paragraphBlock(paragraph))
      paragraph = []
    }
    while i < lines.count {
      let line = lines[i]
      if isBlank(line) {
        flush()
        i += 1
        continue
      }
      let indent = indentOf(line)
      if indent >= 4 {
        if !paragraph.isEmpty {
          // An indented line cannot interrupt a paragraph: it continues it.
          paragraph.append(line)
          i += 1
          continue
        }
        var code: [String] = []
        while i < lines.count, isBlank(lines[i]) || indentOf(lines[i]) >= 4 {
          code.append(isBlank(lines[i]) ? "" : dropSpaces(lines[i], 4))
          i += 1
        }
        while code.last == "" { code.removeLast() }
        out.append(.code(language: nil, text: code.joined(separator: "\n")))
        continue
      }
      if let parts = groups(fenceOpen, line), let marker = parts[1] {
        let info = (parts[2] ?? "").trimmingCharacters(in: .whitespaces)
        if !(marker.first == "`" && info.contains("`")) {
          flush()
          let open = (marker.first!, marker.count)
          var code: [String] = []
          i += 1
          // An unfinished fence runs to the end, as remark reads one while an answer streams.
          while i < lines.count, !closesFence(lines[i], open) {
            code.append(dropSpaces(lines[i], indent))
            i += 1
          }
          i += 1
          let language = info.split(whereSeparator: { $0 == " " || $0 == "\t" }).first.map(String.init)
          out.append(.code(language: language, text: code.joined(separator: "\n")))
          continue
        }
      }
      if let parts = groups(atxHeading, line) {
        flush()
        out.append(.heading(level: parts[1]!.count, inline: inline(parts[2] ?? "")))
        i += 1
        continue
      }
      if !paragraph.isEmpty, groups(setextOne, line) != nil || groups(setextTwo, line) != nil {
        let level = groups(setextOne, line) != nil ? 1 : 2
        out.append(.heading(level: level, inline: inline(joinInline(paragraph))))
        paragraph = []
        i += 1
        continue
      }
      if groups(thematicBreak, line) != nil {
        flush()
        out.append(.rule)
        i += 1
        continue
      }
      if groups(quoteMarker, line) != nil {
        flush()
        var inner: [String] = []
        while i < lines.count {
          if let parts = groups(quoteMarker, lines[i]) {
            inner.append(parts[1] ?? "")
          } else if !isBlank(lines[i]), let last = inner.last, !isBlank(last), !isBlockStart(lines[i]) {
            // A lazy continuation line of the quote's paragraph.
            inner.append(lines[i])
          } else {
            break
          }
          i += 1
        }
        out.append(.quote(blocks(inner)))
        continue
      }
      if let marker = listMarkerOf(line), paragraph.isEmpty || (!marker.content.isEmpty && (!marker.ordered || marker.number == 1)) {
        flush()
        let (block, next) = list(lines, from: i, first: marker)
        out.append(block)
        i = next
        continue
      }
      if i + 1 < lines.count, line.contains("|"), let alignments = delimiterRow(lines[i + 1]) {
        let header = splitRow(line)
        if header.count == alignments.count {
          flush()
          var rows: [[String]] = []
          i += 2
          while i < lines.count, !isBlank(lines[i]), !isBlockStart(lines[i]) {
            var cells = splitRow(lines[i])
            if cells.count < header.count { cells += Array(repeating: "", count: header.count - cells.count) }
            rows.append(Array(cells.prefix(header.count)).map(inline))
            i += 1
          }
          out.append(.table(header: header.map(inline), alignments: alignments, rows: rows))
          continue
        }
      }
      if paragraph.isEmpty, groups(htmlStart, line) != nil {
        var raw: [String] = []
        while i < lines.count, !isBlank(lines[i]) {
          raw.append(lines[i])
          i += 1
        }
        out.append(.html(raw: raw.joined(separator: "\n")))
        continue
      }
      paragraph.append(line)
      i += 1
    }
    flush()
    return out
  }

  private mutating func list(_ lines: [String], from start: Int, first: ListMarker) -> (MarkdownBlock, Int) {
    var items: [[String]] = [[first.content]]
    var offset = first.contentOffset
    var i = start + 1
    func sibling(_ line: String) -> ListMarker? {
      guard let marker = listMarkerOf(line), marker.ordered == first.ordered, marker.delimiter == first.delimiter,
            indentOf(line) < offset else { return nil }
      return marker
    }
    while i < lines.count {
      let line = lines[i]
      if isBlank(line) {
        // A blank line ends the list unless the next text belongs to it.
        var j = i + 1
        while j < lines.count, isBlank(lines[j]) { j += 1 }
        guard j < lines.count, indentOf(lines[j]) >= offset || sibling(lines[j]) != nil else { break }
        items[items.count - 1].append("")
        i += 1
        continue
      }
      if indentOf(line) >= offset {
        items[items.count - 1].append(dropSpaces(line, offset))
      } else if let marker = sibling(line) {
        items.append([marker.content])
        offset = marker.contentOffset
      } else if let last = items.last?.last, !isBlank(last), !isBlockStart(line) {
        // A lazy continuation line of the item's paragraph.
        items[items.count - 1].append(line.trimmingCharacters(in: .whitespaces))
      } else {
        break
      }
      i += 1
    }
    return (.list(ordered: first.ordered, start: first.ordered ? first.number : 1, items: items.map { blocks($0) }), i)
  }

  private func paragraphBlock(_ lines: [String]) -> MarkdownBlock {
    let text = inline(joinInline(lines))
    if let parts = groups(soloImage, text) {
      return .image(url: parts[2] ?? "", alt: parts[1] ?? "")
    }
    return .paragraph(inline: text)
  }

  /// Soft breaks become a space, hard breaks (two trailing spaces or a backslash) a newline.
  private func joinInline(_ lines: [String]) -> String {
    var out = ""
    for (index, raw) in lines.enumerated() {
      var line = String(raw.drop(while: { $0 == " " || $0 == "\t" }))
      let last = index == lines.count - 1
      if last {
        out += line.trimmingCharacters(in: .whitespaces)
        break
      }
      var hard = false
      if line.hasSuffix("\\") {
        line.removeLast()
        hard = true
      } else if line.hasSuffix("  ") {
        hard = true
      }
      out += line.trimmingCharacters(in: .whitespaces) + (hard ? "\n" : " ")
    }
    return out
  }

  /// Inline Markdown with its reference links and images made inline ones; code spans untouched.
  func inline(_ text: String) -> String {
    guard !definitions.isEmpty, text.contains("[") else { return text }
    var out = ""
    var plain = ""
    var index = text.startIndex
    while index < text.endIndex {
      if text[index] == "`" {
        var run = 0
        var probe = index
        while probe < text.endIndex, text[probe] == "`" { run += 1; probe = text.index(after: probe) }
        let fence = String(repeating: "`", count: run)
        if let close = text.range(of: fence, range: probe..<text.endIndex) {
          out += resolveReferences(plain) + String(text[index..<close.upperBound])
          plain = ""
          index = close.upperBound
          continue
        }
        plain += fence
        index = probe
        continue
      }
      plain.append(text[index])
      index = text.index(after: index)
    }
    return out + resolveReferences(plain)
  }

  private static let fullReference = regex("(!?)\\[([^\\[\\]]*)\\]\\[([^\\[\\]]*)\\]")
  private static let shortcutReference = regex("(!?)\\[([^\\[\\]]+)\\](?![\\[(:])")

  private func resolveReferences(_ text: String) -> String {
    let full = replace(Self.fullReference, in: text) { parts in
      let label = (parts[3] ?? "").isEmpty ? parts[2] ?? "" : parts[3]!
      guard let url = definitions[normalizeLabel(label)] else { return nil }
      return "\(parts[1] ?? "")[\(parts[2] ?? "")](\(url))"
    }
    return replace(Self.shortcutReference, in: full) { parts in
      guard let url = definitions[normalizeLabel(parts[2] ?? "")] else { return nil }
      return "\(parts[1] ?? "")[\(parts[2] ?? "")](\(url))"
    }
  }

  private func replace(_ regex: NSRegularExpression, in text: String, _ make: ([String?]) -> String?) -> String {
    let ns = text as NSString
    var out = ""
    var cursor = 0
    for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      let parts = (0..<match.numberOfRanges).map { index -> String? in
        let range = match.range(at: index)
        return range.location == NSNotFound ? nil : ns.substring(with: range)
      }
      // A bracket right after another closing one is the second half of something already read.
      if match.range.location > 0, ns.substring(with: NSRange(location: match.range.location - 1, length: 1)) == "]" { continue }
      guard let replacement = make(parts) else { continue }
      out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)) + replacement
      cursor = match.range.location + match.range.length
    }
    return out + ns.substring(from: cursor)
  }
}
