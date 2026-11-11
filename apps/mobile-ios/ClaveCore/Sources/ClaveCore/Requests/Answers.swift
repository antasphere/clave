import Foundation

// What the phone's forms send back for a pending request, ported from the
// prototype's `apps/mobile/src/requests/answers.ts` and shaped the way the
// server's `PendingRequests.validate` reads it
// (`packages/server/src/requests/service.ts`): a permission answers with one
// of its option ids, plus the answers when it asked questions and the option
// is `answer`; a clarification answers every question under its canonical
// key, none blank; a secret answers its value, which travels in the resolve
// body and nowhere else; a dismissal answers nothing.

/// The key a question's answer is recorded under: its id, else its text.
public func questionKey(_ question: AgentQuestion) -> String { question.answerKey }

/// What the reader chose for one question: the picked option labels and a free answer.
public struct QuestionReply: Sendable, Equatable {
  public var picked: [String]
  public var other: String?

  public init(picked: [String] = [], other: String? = nil) {
    self.picked = picked
    self.other = other
  }
}

/// A response ready to resolve the request with, or the sentence that says what is missing.
public enum ShapedAnswer: Sendable, Equatable {
  case response(RequestResponse)
  case problem(String)
}

/// The text of one question's reply: a multi-select's picks joined with ", " and the free answer
/// after them; a single choice keeps its first pick.
public func answerText(_ question: AgentQuestion, _ reply: QuestionReply?) -> String {
  guard let reply else { return "" }
  let other = reply.other?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let picked = question.multiSelect == true ? reply.picked : Array(reply.picked.prefix(1))
  return (picked + (other.isEmpty ? [] : [other])).joined(separator: ", ").trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Every question's answer under its canonical key: exactly one, none blank, or the sentence
/// naming the first question left unanswered.
public func shapeAnswers(_ questions: [AgentQuestion], _ replies: [String: QuestionReply]) -> Result<[String: String], AnswerProblem> {
  var answers: [String: String] = [:]
  for question in questions {
    let key = questionKey(question)
    // Two questions under one key cannot both be answered; the server counts one answer per question.
    if answers[key] != nil { return .failure(AnswerProblem("Two questions share the key \"\(key)\"; this request cannot be answered here.")) }
    let text = answerText(question, replies[key])
    if text.isEmpty { return .failure(AnswerProblem("Answer \"\(question.header ?? question.question)\" first.")) }
    answers[key] = text
  }
  return .success(answers)
}

/// Why a request cannot be answered yet, in a sentence.
public struct AnswerProblem: Error, Sendable, Equatable {
  public let message: String
  public init(_ message: String) { self.message = message }
}

/// The answer to a permission, or to a native question answered as one (`answersAsPermission`).
public func shapePermission(_ request: PendingRequest, optionId: String, replies: [String: QuestionReply] = [:]) -> ShapedAnswer {
  guard request.options?.contains(where: { $0.id == optionId }) == true else {
    return .problem("That option is not one of this request.")
  }
  if let questions = request.questions, !questions.isEmpty, optionId == "answer" {
    switch shapeAnswers(questions, replies) {
    case .failure(let problem): return .problem(problem.message)
    case .success(let answers): return .response(.permission(optionId: optionId, answers: answers))
    }
  }
  return .response(.permission(optionId: optionId, answers: nil))
}

/// The answer to a clarification: every question's answer.
public func shapeClarification(_ request: PendingRequest, replies: [String: QuestionReply]) -> ShapedAnswer {
  switch shapeAnswers(request.questions ?? [], replies) {
  case .failure(let problem): return .problem(problem.message)
  case .success(let answers): return .response(.clarification(answers: answers))
  }
}

/// The answer to a secret: its value, never empty, carried in the resolve body only.
public func shapeSecret(_ value: String) -> ShapedAnswer {
  value.isEmpty ? .problem("Enter the secret first.") : .response(.secret(value: value))
}

/// The answer that dismisses a request.
public let dismissal = RequestResponse.dismiss

/// A request the server holds under a provider's id (a native prompt of the agent) answers like a
/// permission even when its kind is clarification: the server reads `permission` with `answer`.
public func answersAsPermission(_ request: PendingRequest) -> Bool {
  request.kind == .permission || request.providerRequestId != nil
}

/// Whether a question's input is masked: its canonical key is among the request's `secretQuestions`.
public func isMaskedQuestion(_ request: PendingRequest, _ question: AgentQuestion) -> Bool {
  request.secretQuestions?.contains(questionKey(question)) ?? false
}

/// The server's own check of a response, run before it leaves so a refusal is said here: nil when
/// the server will take it, else the sentence.
public func validateResponse(_ request: PendingRequest, _ response: RequestResponse) -> String? {
  let invalid = "This answer does not fit the request."
  if case .dismiss = response { return nil }
  if request.kind == .secret {
    if case .secret(let value) = response, !value.isEmpty { return nil }
    return invalid
  }
  if answersAsPermission(request) {
    guard case .permission(let optionId, let answers) = response,
          request.options?.contains(where: { $0.id == optionId }) == true else { return invalid }
    if let questions = request.questions, !questions.isEmpty, optionId == "answer" {
      return validAnswers(questions, answers) ? nil : invalid
    }
    return answers == nil ? nil : invalid
  }
  guard case .clarification(let answers) = response else { return invalid }
  return validAnswers(request.questions ?? [], answers) ? nil : invalid
}

private func validAnswers(_ questions: [AgentQuestion], _ answers: [String: String]?) -> Bool {
  guard let answers, answers.count == questions.count else { return false }
  return questions.allSatisfy { question in
    guard let answer = answers[questionKey(question)] else { return false }
    return !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
