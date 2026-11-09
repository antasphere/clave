import XCTest
@testable import ClaveCore

final class RequestsAnswersTests: XCTestCase {
  private let permission = PendingRequest(id: "p", sessionId: "s", kind: .permission, description: "Run ls?", createdAt: 1, options: [PermissionOption(id: "allow-once", label: "Allow once"), PermissionOption(id: "deny", label: "Deny")])
  private let questions = PendingRequest(
    id: "q", sessionId: "s", kind: .clarification, description: "Two questions", createdAt: 1, providerRequestId: "native-3",
    options: [PermissionOption(id: "answer", label: "Answer"), PermissionOption(id: "deny", label: "Skip")],
    questions: [
      AgentQuestion(id: "colour", question: "Which colour?", options: [AgentQuestionOption(label: "Red"), AgentQuestionOption(label: "Blue")], multiSelect: true),
      AgentQuestion(question: "Why?", options: [AgentQuestionOption(label: "Because")]),
    ])

  private func without(_ request: PendingRequest, providerRequestId: Bool = false, options: Bool = false, secretQuestions: [String]? = nil) -> PendingRequest {
    PendingRequest(id: request.id, sessionId: request.sessionId, kind: request.kind, description: request.description, createdAt: request.createdAt, providerRequestId: providerRequestId ? nil : request.providerRequestId, options: options ? nil : request.options, questions: request.questions, secretQuestions: secretQuestions)
  }

  func testAPermissionAnswersWithOneOfItsOptionsAndNothingElse() {
    XCTAssertEqual(shapePermission(permission, optionId: "allow-once"), .response(.permission(optionId: "allow-once", answers: nil)))
    XCTAssertEqual(shapePermission(permission, optionId: "allow-always"), .problem("That option is not one of this request."))
  }

  func testANativeQuestionAnswersLikeAPermissionWithTheAnswersKeyedByIdOrText() {
    XCTAssertTrue(answersAsPermission(questions))
    XCTAssertTrue(answersAsPermission(permission))
    XCTAssertFalse(answersAsPermission(without(questions, providerRequestId: true)))
    let shaped = shapePermission(questions, optionId: "answer", replies: [
      "colour": QuestionReply(picked: ["Red", "Blue"], other: "and a bit of green"),
      "Why?": QuestionReply(picked: ["Because"]),
    ])
    XCTAssertEqual(shaped, .response(.permission(optionId: "answer", answers: ["colour": "Red, Blue, and a bit of green", "Why?": "Because"])))
    if case .response(let response) = shaped { XCTAssertNil(validateResponse(questions, response)) }
  }

  func testAMissingAnswerNamesTheQuestionAndSendsNothing() {
    XCTAssertEqual(shapePermission(questions, optionId: "answer", replies: ["colour": QuestionReply(picked: ["Red"])]), .problem("Answer \"Why?\" first."))
    XCTAssertEqual(shapePermission(questions, optionId: "deny"), .response(.permission(optionId: "deny", answers: nil)))
  }

  func testASingleChoiceKeepsOnePickAndAFreeAnswerAloneCounts() {
    let q = questions.questions![1]
    XCTAssertEqual(answerText(q, QuestionReply(picked: ["Because", "Other"])), "Because")
    XCTAssertEqual(answerText(q, QuestionReply(picked: [], other: "  typed  ")), "typed")
    XCTAssertEqual(answerText(q, nil), "")
  }

  func testAClarificationWithoutAProviderIdAnswersAsAClarification() {
    let plain = without(questions, providerRequestId: true, options: true)
    let shaped = shapeClarification(plain, replies: ["colour": QuestionReply(picked: ["Blue"]), "Why?": QuestionReply(other: "x")])
    XCTAssertEqual(shaped, .response(.clarification(answers: ["colour": "Blue", "Why?": "x"])))
    XCTAssertEqual(validateResponse(plain, .clarification(answers: ["colour": "Blue"])), "This answer does not fit the request.")
    XCTAssertEqual(validateResponse(plain, .clarification(answers: ["colour": "Blue", "Why?": "  "])), "This answer does not fit the request.")
    XCTAssertEqual(validateResponse(plain, .clarification(answers: ["colour": "Blue", "Why?": "x", "extra": "y"])), "This answer does not fit the request.")
  }

  func testTwoQuestionsUnderOneKeyCannotBeAnswered() {
    let twice = PendingRequest(id: "d", sessionId: "s", kind: .clarification, description: "d", createdAt: 1, questions: [
      AgentQuestion(question: "Same?", options: []), AgentQuestion(question: "Same?", options: []),
    ])
    guard case .problem = shapeClarification(twice, replies: ["Same?": QuestionReply(other: "yes")]) else { return XCTFail() }
  }

  func testASecretTravelsAsItsValueOnlyInTheBodyAndNeverEmpty() throws {
    XCTAssertEqual(shapeSecret(""), .problem("Enter the secret first."))
    XCTAssertEqual(shapeSecret("shh"), .response(.secret(value: "shh")))
    let body = try ContractJSON.encodeToString(ResolveRequestInput(requestId: "r-1", response: .secret(value: "shh")))
    XCTAssertTrue(body.contains("\"value\":\"shh\""))
    XCTAssertFalse(body.contains("r-1shh"))
    let secret = PendingRequest(id: "k", sessionId: "s", kind: .secret, description: "API key", createdAt: 1)
    XCTAssertNil(validateResponse(secret, .secret(value: "shh")))
    XCTAssertNotNil(validateResponse(secret, .secret(value: "")))
    XCTAssertNil(validateResponse(secret, dismissal))
  }

  func testMaskedQuestionsComeFromSecretQuestionsByCanonicalKey() {
    let masked = without(questions, secretQuestions: ["colour"])
    XCTAssertTrue(isMaskedQuestion(masked, masked.questions![0]))
    XCTAssertFalse(isMaskedQuestion(masked, masked.questions![1]))
    XCTAssertFalse(isMaskedQuestion(questions, questions.questions![0]))
  }

  func testAPermissionWithoutQuestionsCarriesNoAnswers() {
    XCTAssertNotNil(validateResponse(permission, .permission(optionId: "allow-once", answers: ["x": "y"])))
    XCTAssertNotNil(validateResponse(permission, .clarification(answers: [:])))
  }
}
