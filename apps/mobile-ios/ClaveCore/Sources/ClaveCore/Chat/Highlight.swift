import Foundation

// The colors of a fenced block. The prototype (`apps/mobile/src/chat/highlight.ts`)
// runs the desktop's Shiki grammars with GitHub's light and dark themes; no
// such engine is in Foundation, so this is a small lexical highlighter over
// the same contract: a known language comes back as lines of tokens whose
// text joins to the exact source, line endings included; an unknown or
// unlabelled block comes back nil and is shown plain; the four app themes
// map onto the same two palettes the desktop uses.

/// What a run of code is, for the screen's palette.
public enum CodeTokenKind: String, Sendable, Equatable {
  case plain, keyword, string, comment, number, inserted, deleted, meta
}

/// A run of code and its kind.
public struct CodeToken: Sendable, Equatable {
  public let text: String
  public let kind: CodeTokenKind

  public init(_ text: String, _ kind: CodeTokenKind) {
    self.text = text
    self.kind = kind
  }
}

/// The two code palettes, GitHub light and GitHub dark.
public enum CodePalette: String, Sendable, Equatable {
  case light, dark

  /// The palette an app theme draws code in: light and coffee are light, every other theme dark.
  public init(theme: String) {
    self = theme == "light" || theme == "coffee" ? .light : .dark
  }
}

private struct Grammar {
  var keywords: Set<String>
  var lineComments: [String]
  var blockComment: (String, String)?
  var quotes: Set<Character>
  var diff = false
}

private let cKeywords: Set<String> = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "true", "false", "null", "nil", "void", "new", "class", "struct", "enum", "interface", "extends", "implements", "public", "private", "protected", "static", "final", "const", "let", "var", "func", "function", "import", "export", "from", "as", "try", "catch", "finally", "throw", "throws", "async", "await", "in", "of", "is", "typeof", "instanceof", "this", "self", "super", "type", "guard", "where", "protocol", "extension", "package", "fn", "pub", "mut", "impl", "trait", "use", "mod", "match", "go", "defer", "chan", "map", "range", "val", "fun", "object", "when", "override", "undefined", "int", "string", "bool", "boolean", "number", "char", "float", "double", "long", "yield", "init", "deinit", "inout", "some", "any", "namespace", "using", "readonly", "declare", "abstract", "sealed", "data"]
private let pythonKeywords: Set<String> = ["def", "class", "if", "elif", "else", "for", "while", "return", "import", "from", "as", "try", "except", "finally", "raise", "with", "lambda", "yield", "pass", "break", "continue", "in", "is", "not", "and", "or", "None", "True", "False", "async", "await", "global", "nonlocal", "del", "assert", "self"]
private let rubyKeywords: Set<String> = ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "nil", "true", "false", "self", "require", "then", "case", "when", "and", "or", "not"]
private let shellKeywords: Set<String> = ["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "readonly", "echo", "cd", "exit", "set", "unset", "source"]
private let sqlKeywords: Set<String> = ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "and", "or", "not", "null", "as", "distinct", "index", "primary", "key", "references", "union", "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "AND", "OR", "NOT", "NULL", "AS", "DISTINCT", "INDEX", "PRIMARY", "KEY", "REFERENCES", "UNION"]
private let dataKeywords: Set<String> = ["true", "false", "null", "yes", "no", "on", "off"]

private let cLike = Grammar(keywords: cKeywords, lineComments: ["//"], blockComment: ("/*", "*/"), quotes: ["\"", "'", "`"])
private let grammars: [String: Grammar] = {
  var table: [String: Grammar] = [:]
  for name in ["javascript", "js", "jsx", "mjs", "cjs", "typescript", "ts", "tsx", "mts", "cts", "swift", "kotlin", "kt", "java", "c", "cpp", "c++", "h", "hpp", "csharp", "cs", "go", "rust", "rs", "scala", "dart", "objective-c", "objc", "php", "css", "scss", "less", "jsonc", "groovy", "zig"] {
    table[name] = cLike
  }
  for name in ["python", "py"] { table[name] = Grammar(keywords: pythonKeywords, lineComments: ["#"], blockComment: nil, quotes: ["\"", "'"]) }
  for name in ["ruby", "rb"] { table[name] = Grammar(keywords: rubyKeywords, lineComments: ["#"], blockComment: nil, quotes: ["\"", "'"]) }
  for name in ["bash", "sh", "shell", "zsh", "shellscript", "fish", "console"] { table[name] = Grammar(keywords: shellKeywords, lineComments: ["#"], blockComment: nil, quotes: ["\"", "'"]) }
  for name in ["yaml", "yml", "toml", "ini", "dockerfile", "makefile", "make"] { table[name] = Grammar(keywords: dataKeywords, lineComments: ["#"], blockComment: nil, quotes: ["\"", "'"]) }
  table["json"] = Grammar(keywords: dataKeywords, lineComments: [], blockComment: nil, quotes: ["\""])
  table["sql"] = Grammar(keywords: sqlKeywords, lineComments: ["--"], blockComment: ("/*", "*/"), quotes: ["'", "\""])
  for name in ["html", "xml", "svg", "vue", "svelte"] { table[name] = Grammar(keywords: [], lineComments: [], blockComment: ("<!--", "-->"), quotes: ["\"", "'"]) }
  for name in ["diff", "patch"] { table[name] = Grammar(keywords: [], lineComments: [], blockComment: nil, quotes: [], diff: true) }
  return table
}()

/// Whether a fence's language is one the highlighter colors.
public func isHighlightable(_ language: String?) -> Bool {
  language.map { grammars[$0.lowercased()] != nil } ?? false
}

/// The block as lines of tokens, each line's tokens joining to the line and the lines joined by
/// "\n" to the exact source; nil for an unknown or missing language, which stays plain text.
public func highlightCode(_ code: String, language: String?) -> [[CodeToken]]? {
  guard let language, let grammar = grammars[language.lowercased()] else { return nil }
  var inBlock = false
  return code.components(separatedBy: "\n").map { line in
    grammar.diff ? diffLine(line) : tokenize(line, grammar, inBlock: &inBlock)
  }
}

private func diffLine(_ line: String) -> [CodeToken] {
  if line.isEmpty { return [] }
  if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") { return [CodeToken(line, .meta)] }
  if line.hasPrefix("+") { return [CodeToken(line, .inserted)] }
  if line.hasPrefix("-") { return [CodeToken(line, .deleted)] }
  return [CodeToken(line, .plain)]
}

private func tokenize(_ line: String, _ grammar: Grammar, inBlock: inout Bool) -> [CodeToken] {
  let chars = Array(line)
  var tokens: [CodeToken] = []
  var i = 0
  func push(_ text: String, _ kind: CodeTokenKind) {
    guard !text.isEmpty else { return }
    if let last = tokens.last, last.kind == kind {
      tokens[tokens.count - 1] = CodeToken(last.text + text, kind)
    } else {
      tokens.append(CodeToken(text, kind))
    }
  }
  func starts(_ prefix: String, at index: Int) -> Bool {
    let p = Array(prefix)
    return index + p.count <= chars.count && Array(chars[index..<index + p.count]) == p
  }
  while i < chars.count {
    if inBlock, let (_, close) = grammar.blockComment {
      var j = i
      while j < chars.count && !starts(close, at: j) { j += 1 }
      if j < chars.count {
        j += close.count
        inBlock = false
      }
      push(String(chars[i..<j]), .comment)
      i = j
      continue
    }
    if let (open, _) = grammar.blockComment, starts(open, at: i) {
      inBlock = true
      push(open, .comment)
      i += open.count
      continue
    }
    if grammar.lineComments.contains(where: { starts($0, at: i) }) {
      push(String(chars[i...]), .comment)
      break
    }
    let c = chars[i]
    if grammar.quotes.contains(c) {
      var j = i + 1
      while j < chars.count && chars[j] != c {
        j += chars[j] == "\\" ? 2 : 1
      }
      j = min(j + 1, chars.count)
      push(String(chars[i..<j]), .string)
      i = j
      continue
    }
    if c.isNumber && (i == 0 || !(chars[i - 1].isLetter || chars[i - 1] == "_")) {
      var j = i
      while j < chars.count && (chars[j].isNumber || chars[j].isLetter || chars[j] == "." || chars[j] == "_") { j += 1 }
      push(String(chars[i..<j]), .number)
      i = j
      continue
    }
    if c.isLetter || c == "_" || c == "$" || c == "@" {
      var j = i
      while j < chars.count && (chars[j].isLetter || chars[j].isNumber || chars[j] == "_" || chars[j] == "$" || chars[j] == "@") { j += 1 }
      let word = String(chars[i..<j])
      push(word, grammar.keywords.contains(word) ? .keyword : .plain)
      i = j
      continue
    }
    push(String(c), .plain)
    i += 1
  }
  return tokens
}
