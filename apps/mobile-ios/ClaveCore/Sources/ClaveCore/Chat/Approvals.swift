import Foundation

// The transcript's reading of an approval, ported from the prototype's
// `apps/mobile/src/chat/approvals.ts` (the desktop's
// `apps/plugins/chat-view/src/approvals.ts`, Clave, MIT), semantics unchanged:
// what was asked in words a reader understands, what the reader said, and
// which rows fold into a run.

/// The Clave tool server as the Codex adapter binds it: `clave`, or `clave_` and twelve hex digits.
private let claveServer = try! NSRegularExpression(pattern: "^clave(_[a-f0-9]{12})?$")
private let commandMethods: Set<String> = ["item/commandExecution/requestApproval", "execCommandApproval"]
private let editMethods: Set<String> = ["item/fileChange/requestApproval", "applyPatchApproval"]
private let decisionWords: [String: String] = [
  "accept": "Allowed",
  "acceptForSession": "Allowed for the session",
  "approved": "Allowed",
  "approved_for_session": "Allowed for the session",
  "decline": "Declined",
  "cancel": "Cancelled",
  "abort": "Cancelled",
]
private let refusalId = try! NSRegularExpression(pattern: "deny|decline|cancel|reject|abort", options: [.caseInsensitive])
private let refusalLabel = try! NSRegularExpression(pattern: "^(deny|decline|cancel|reject|abort|skip)\\b", options: [.caseInsensitive])
private let runToolMessage = try! NSRegularExpression(pattern: "run tool \"([^\"]+)\"")

func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
  regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
}

func firstGroup(_ regex: NSRegularExpression, _ text: String) -> String? {
  let ns = text as NSString
  guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
        match.range(at: 1).location != NSNotFound else { return nil }
  return ns.substring(with: match.range(at: 1))
}

/// A refusal, by the option's id (the words every provider uses) or, when the ids say nothing, by its label.
public func isRefusalOption(_ option: PermissionOption) -> Bool {
  matches(refusalId, option.id) || matches(refusalLabel, option.label)
}

/// Whether the reader's answer refused the request.
public func refused(_ request: PermissionRequestEvent, _ answer: String) -> Bool {
  if let option = request.options.first(where: { $0.id == answer }) { return isRefusalOption(option) }
  return matches(refusalId, answer)
}

/// What the reader said, as the row shows it: the provider's own label, else the words of a raw id.
public func decisionWord(_ request: PermissionRequestEvent, _ answer: String) -> String {
  let option = request.options.first { $0.id == answer }
  if let option, option.label != option.id { return option.label }
  return decisionWords[answer] ?? option?.label ?? answer
}

/// A request answered with words rather than allowed: one that asks questions, or one that names no tool.
public func isQuestion(_ request: PermissionRequestEvent) -> Bool {
  request.questions != nil || (request.toolName ?? "").isEmpty
}

private func text(_ value: JSONValue?) -> String { value?.stringValue ?? "" }

private func commandText(_ p: [String: JSONValue]) -> String {
  if case .string(let command)? = p["command"] { return command }
  if case .array(let argv)? = p["command"], argv.allSatisfy({ $0.stringValue != nil }) {
    return argv.compactMap(\.stringValue).joined(separator: " ")
  }
  if case .array(let actions)? = p["commandActions"], let first = actions.first {
    return text(first["command"])
  }
  return ""
}

/// What a Codex request asked, in the reader's words; nil for one the view describes by its tool name (Claude's).
public func describeApproval(_ request: PermissionRequestEvent) -> (label: String, target: String)? {
  let method = request.toolName ?? ""
  let p = request.input?.objectValue ?? [:]
  func or(_ a: String, _ b: String) -> String { a.isEmpty ? b : a }
  if commandMethods.contains(method) { return ("Run a command", or(commandText(p), text(p["reason"]))) }
  if editMethods.contains(method) { return ("Edit files", or(text(p["reason"]), text(p["grantRoot"]))) }
  if method == "item/permissions/requestApproval" {
    let keys = (p["permissions"]?.objectValue ?? [:]).keys.sorted().joined(separator: ", ")
    return ("Extra permissions", or(text(p["reason"]), keys))
  }
  if method == "mcpServer/elicitation/request" {
    // Codex names the tool in the message alone; a frame that names it under its own key is read first.
    let tool = or(text(p["_meta"]?["tool_name"]), firstGroup(runToolMessage, text(p["message"])) ?? "")
    let server = text(p["serverName"])
    return (tool.isEmpty ? "Use a tool" : "Use \(tool)", matches(claveServer, server) ? "Clave" : or(server, text(p["message"])))
  }
  return nil
}

/// An approval the reader allowed and nothing more is owed on: answered here, not a question,
/// not a refusal. The rows that fold into a run.
public func settledApproval(_ card: PermissionCard) -> Bool {
  guard let answer = card.answer else { return false }
  return !isQuestion(card.request) && !refused(card.request, answer)
}

/// The one line a closed run of approvals shows: how many were allowed, and of what.
public func approvalRunSummary(_ approvals: [PermissionCard]) -> (head: String, detail: String) {
  var order: [String] = []
  var counts: [String: Int] = [:]
  for card in approvals {
    let label = describeApproval(card.request)?.label ?? card.request.toolName ?? "request"
    if counts[label] == nil { order.append(label) }
    counts[label, default: 0] += 1
  }
  return (
    "Allowed \(approvals.count) \(approvals.count == 1 ? "request" : "requests")",
    order.map { counts[$0]! > 1 ? "\($0) ×\(counts[$0]!)" : $0 }.joined(separator: " · ")
  )
}
