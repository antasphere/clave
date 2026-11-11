import XCTest
@testable import ClaveCore

/// The wire shapes decode from the server's own JSON (the prototype's
/// pin-test samples, kept as fixtures) and refuse what the contract refuses.
final class ContractDecodingTests: XCTestCase {
  private func fixture(_ name: String) throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"), "fixture \(name)")
    return try Data(contentsOf: url)
  }

  func testSession() throws {
    let session = try ContractJSON.decode(Session.self, from: fixture("session"))
    XCTAssertEqual(session.id, "s1")
    XCTAssertEqual(session.transport, .events)
    XCTAssertEqual(session.state, .working)
    XCTAssertEqual(session.createdAt, 1_730_000_000_000)
    XCTAssertEqual(session.viewId, "clave.chat/chat")
    XCTAssertNil(session.workspaceId)
    let again = try ContractJSON.decode(Session.self, from: ContractJSON.encode(session))
    XCTAssertEqual(again, session)
  }

  func testEverySessionEventMember() throws {
    let events = try ContractJSON.decode([SessionEvent].self, from: fixture("events"))
    XCTAssertEqual(events.count, 20)
    guard case .userMessage(let withAttachments) = events[1] else { return XCTFail("events[1]") }
    XCTAssertEqual(withAttachments.attachments?.count, 2)
    guard case .file(let file)? = withAttachments.attachments?.first else { return XCTFail("a file attachment") }
    XCTAssertEqual(file.label, "Image #1")
    XCTAssertEqual(file.delivery, .image)
    guard case .session(let other)? = withAttachments.attachments?.last else { return XCTFail("a session attachment") }
    XCTAssertEqual(other.sessionId, "s2")
    XCTAssertEqual(events[2], .assistantText(delta: "hel", final: false, parent: nil))
    XCTAssertEqual(events[5], .toolCall(id: "t1", name: "Read", input: .object(["path": .string("/x")]), parent: "p"))
    XCTAssertEqual(events[6], .toolResult(id: "t1", output: .string("ok"), error: false, parent: nil))
    XCTAssertEqual(events[8], .permissionWithdrawn(id: "retired"))
    guard case .permissionRequest(let request) = events[9] else { return XCTFail("events[9]") }
    XCTAssertEqual(request.options.map(\.id), ["allow-once", "deny"])
    XCTAssertEqual(request.questions?.first?.multiSelect, true)
    XCTAssertEqual(request.questions?.first?.options.last?.description, nil)
    XCTAssertEqual(events[10], .stateChange(.blocked))
    XCTAssertEqual(events[11], .sessionMeta(model: "claude-opus-5-5", providerSessionId: nil))
    XCTAssertEqual(events[12], .effort("high"))
    XCTAssertEqual(events[13], .error(message: "boom", fatal: true))
    XCTAssertEqual(events[14], .turnInterrupted)
    XCTAssertEqual(events[15], .contextUsage(used: 10, window: 200, parent: "p"))
    XCTAssertEqual(events[16], .subagentModel(parent: "p", model: "m"))
    XCTAssertEqual(events[17], .permissionMode(mode: "default", modes: [PermissionOption(id: "default", label: "Default")]))
    guard case .backgroundTasks(let tasks) = events[18] else { return XCTFail("events[18]") }
    XCTAssertEqual(tasks.first?.kind, .shell)
    XCTAssertEqual(events[19], .providerEvent(provider: "codex", payload: .object(["any": .number(1)])))
    // Every member survives a round trip through the encoder.
    let again = try ContractJSON.decode([SessionEvent].self, from: ContractJSON.encode(events))
    XCTAssertEqual(again, events)
  }

  func testAnEventTheContractAddsLaterIsCarriedByItsType() throws {
    let event = try ContractJSON.decode(SessionEvent.self, from: #"{"type":"later_thing","x":1}"#)
    XCTAssertEqual(event, .unknown(type: "later_thing"))
  }

  func testPendingRequestAndSnapshot() throws {
    let request = try ContractJSON.decode(PendingRequest.self, from: fixture("request"))
    XCTAssertEqual(request.kind, .clarification)
    XCTAssertEqual(request.secretQuestions, ["q"])
    XCTAssertEqual(request.questions?.first?.answerKey, "q")
    XCTAssertEqual(request.action, .envFile(file: "/tmp/.env", key: "KEY"))
    XCTAssertEqual(request.input, .object(["x": .number(1)]))
    let snapshot = try ContractJSON.decode(RequestSnapshot.self, from: #"{"revision":2,"pending":[]}"#)
    XCTAssertEqual(snapshot.revision, 2)
    XCTAssertTrue(snapshot.pending.isEmpty)
  }

  func testLaunchProfiles() throws {
    let profiles = try ContractJSON.decode(LaunchProfilePreferencesView.self, from: fixture("launch-profiles"))
    XCTAssertEqual(profiles.customProfiles.map(\.id), ["claude-chat", "pi-x"])
    XCTAssertEqual(profiles.customProfiles[1].pi?.thinking, .high)
    XCTAssertEqual(profiles.globalDefaults["claude"], "claude-chat")
    XCTAssertEqual(profiles.workspaceOverrides["ws1"]?["codex"], "codex-chat")
  }

  func testWorkspaces() throws {
    let state = try ContractJSON.decode(WorkspaceStateView.self, from: fixture("workspaces"))
    XCTAssertEqual(state.workspaces.first?.rootDir, "/tmp/scratch")
    XCTAssertNil(state.workspaces.first?.profileFile)
    XCTAssertNil(state.activeWorkspaceId)
    XCTAssertEqual(state.lastActiveWorkspaceId, "ws1")
    XCTAssertEqual(state.pins, [.object(["anything": .bool(true)])])
  }

  func testSessionInfoAndFileText() throws {
    let info = try ContractJSON.decode(SessionInfo.self, from: fixture("info"))
    XCTAssertEqual(info.folderName, "scratch")
    XCTAssertNil(info.claudeSessionId)
    let text = try ContractJSON.decode(FileText.self, from: #"{"content":"a heading","truncated":false,"size":9,"binary":false}"#)
    XCTAssertEqual(text.content, "a heading")
  }

  func testEnvelopeAndEveryFrameThePhoneReads() throws {
    let envelope = try ContractJSON.decode(ServerEventEnvelope.self, from: fixture("envelope"))
    XCTAssertEqual(envelope.event, .sessionStateChanged(id: "s1", state: .done))
    let frames = try ContractJSON.decode([ServerFrame].self, from: fixture("frames"))
    XCTAssertEqual(frames.count, 13)
    XCTAssertEqual(frames[0], .welcome(serverId: "srv-1", version: "1.72.0"))
    guard case .subscribed(let id, let session) = frames[1] else { return XCTFail("frames[1]") }
    XCTAssertEqual(id, "s1")
    XCTAssertEqual(session.title, "A chat")
    XCTAssertEqual(frames[2], .unsubscribed(sessionId: "s1"))
    XCTAssertEqual(frames[3], .stream(sessionId: "s1", stream: .event(.assistantText(delta: "hi", final: true, parent: nil), position: SessionPosition(generation: "g1", sequence: 7))))
    XCTAssertEqual(frames[4], .stream(sessionId: "s1", stream: .pty(data: "aGk=")))
    XCTAssertEqual(frames[5], .exit(sessionId: "s1", code: 0))
    guard case .event(let e1) = frames[6] else { return XCTFail("frames[6]") }
    XCTAssertEqual(e1.event, .requestsChanged(revision: 9))
    guard case .event(let e2) = frames[7], case .workspacesStateChanged(let workspaces, 4, "i-1") = e2.event else { return XCTFail("frames[7]") }
    XCTAssertEqual(workspaces.map(\.id), ["ws1"])
    guard case .event(let e3) = frames[8] else { return XCTFail("frames[8]") }
    XCTAssertEqual(e3.event, .devicesChanged(revision: 2))
    guard case .event(let e4) = frames[9] else { return XCTFail("frames[9]") }
    XCTAssertEqual(e4.event, .unknown(tag: "plugins.changed"))
    XCTAssertEqual(frames[10], .error(sessionId: "s1", message: "unknown session"))
    XCTAssertEqual(frames[11], .pong)
    XCTAssertEqual(frames[12], .other(tag: "request"))
  }

  func testAFrameThatIsNotJSONOrNotAFrameIsDropped() {
    XCTAssertNil(ServerFrame.parse("not json"))
    XCTAssertNil(ServerFrame.parse(#"{"no":"tag"}"#))
    XCTAssertNil(ServerFrame.parse(#"{"_tag":"welcome","serverId":"x","protocol":2}"#))
    XCTAssertEqual(ServerFrame.parse(#"{"_tag":"pong"}"#), .pong)
  }

  func testADeclaredFailureAsA422CarriesIt() throws {
    let failure = try ContractJSON.decode(ServerFailure.self, from: fixture("failure"))
    XCTAssertEqual(failure.tag, "DevicePairingRefused")
    XCTAssertEqual(failure.check, "audience")
    let bare = try ContractJSON.decode(ServerFailure.self, from: #"{"_tag":"SessionNotFound","id":"s1"}"#)
    XCTAssertEqual(bare.message, "The server refused (SessionNotFound).")
    XCTAssertEqual(bare.id, "s1")
    let capability = try ContractJSON.decode(ServerFailure.self, from: #"{"_tag":"CapabilityUnavailable","capability":"requests","message":"No requests here."}"#)
    XCTAssertEqual(capability.capability, "requests")
  }

  func testTheOrderedTimeline() throws {
    let page = try ContractJSON.decode(TimelinePage.self, from: fixture("timeline"))
    XCTAssertEqual(page.items.count, 2)
    XCTAssertEqual(page.cursor, SessionPosition(generation: "g1", sequence: 3))
    XCTAssertNil(page.before)
    XCTAssertFalse(page.truncated)
    guard case .userMessage(let first) = page.items[0].event else { return XCTFail("items[0]") }
    XCTAssertEqual(first.clientMessageId, "m-1")
    XCTAssertTrue(page.items[0].position < page.items[1].position)
    XCTAssertFalse(SessionPosition(generation: "g1", sequence: 1) < SessionPosition(generation: "g2", sequence: 2))
  }

  func testTheTimelineRefusesWhatTheContractRefuses() {
    let base = #"{"items":[],"before":null,"cursor":{"generation":"g1","sequence":0},"truncated":false}"#
    XCTAssertNoThrow(try ContractJSON.decode(TimelinePage.self, from: base))
    func refused(_ text: String, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
      XCTAssertThrowsError(try ContractJSON.decode(TimelinePage.self, from: text), label, file: file, line: line) { error in
        XCTAssertTrue(error is DecodeError, "\(label): \(error)", file: file, line: line)
      }
    }
    refused(#"{"items":[],"before":null,"cursor":{"generation":"","sequence":0},"truncated":false}"#, "an empty generation")
    refused(#"{"items":[],"before":null,"cursor":{"generation":"g1","sequence":-1},"truncated":false}"#, "a negative sequence")
    refused(#"{"items":[],"before":null,"cursor":{"generation":"g1","sequence":1.5},"truncated":false}"#, "a fractional sequence")
    refused(#"{"items":[],"before":null,"cursor":{"generation":"g1","sequence":9007199254740992},"truncated":false}"#, "an unsafe sequence")
    refused(#"{"items":[],"cursor":{"generation":"g1","sequence":0},"truncated":false}"#, "a missing before")
    refused(#"{"items":[],"before":null,"cursor":{"generation":"g1","sequence":0}}"#, "a missing truncated")
    let event = #"{"type":"turn_interrupted"}"#
    refused(#"{"items":[{"event":\#(event),"position":{"generation":"g2","sequence":1}}],"before":null,"cursor":{"generation":"g1","sequence":3},"truncated":false}"#, "a page mixing generations")
    refused(#"{"items":[{"event":\#(event),"position":{"generation":"g1","sequence":2}},{"event":\#(event),"position":{"generation":"g1","sequence":1}}],"before":null,"cursor":{"generation":"g1","sequence":3},"truncated":false}"#, "reversed positions")
    refused(#"{"items":[{"event":\#(event),"position":{"generation":"g1","sequence":1}},{"event":\#(event),"position":{"generation":"g1","sequence":1}}],"before":null,"cursor":{"generation":"g1","sequence":3},"truncated":false}"#, "a repeated position")
    refused(#"{"items":[{"event":\#(event),"position":{"generation":"g1","sequence":4}}],"before":null,"cursor":{"generation":"g1","sequence":3},"truncated":false}"#, "a position above the watermark")
  }

  func testTheMirrorRefusesWhatTheContractRefuses() {
    XCTAssertThrowsError(try ContractJSON.decode(Session.self, from: #"{"id":"s1","provider":"claude","transport":"events","cwd":"/","windowKey":"w","state":"sleeping","createdAt":1,"adapterId":"a","title":"t"}"#)) { error in
      let decode = error as? DecodeError
      XCTAssertEqual(decode?.path, "body.state")
      XCTAssertEqual(decode?.expected, "one of idle, working, blocked, done, ended")
    }
    XCTAssertThrowsError(try ContractJSON.decode(Session.self, from: #"{"id":"s1"}"#)) { error in
      XCTAssertEqual((error as? DecodeError)?.path, "body.provider")
    }
    XCTAssertThrowsError(try ContractJSON.decode(SessionEvent.self, from: #"{"type":"assistant_text","delta":1,"final":true}"#)) { error in
      XCTAssertEqual((error as? DecodeError)?.path, "body.delta")
    }
    XCTAssertThrowsError(try ContractJSON.decode(Session.self, from: #"{"id":"","provider":"claude","transport":"events","cwd":"/","windowKey":"w","state":"idle","createdAt":1,"adapterId":"a","title":"t"}"#)) { error in
      XCTAssertEqual((error as? DecodeError)?.path, "body.id")
    }
  }

  func testWhatThePhoneSendsEncodesAsTheContractReads() throws {
    let start = StartSessionInput(cwd: "/tmp/scratch", options: SpawnOptions(claudeMode: true, launchProfileId: "claude-chat", launchProfile: LaunchProfileView(id: "claude-chat", name: "Claude (chat)", family: .claude, command: ["claude"], additionalArgs: [], builtIn: true, sourceProfileId: "claude"), workspaceId: "ws1"))
    let startJSON = try ContractJSON.encodeToString(start)
    XCTAssertEqual(startJSON, #"{"cwd":"/tmp/scratch","options":{"claudeMode":true,"launchProfile":{"additionalArgs":[],"builtIn":true,"command":["claude"],"family":"claude","id":"claude-chat","name":"Claude (chat)","sourceProfileId":"claude"},"launchProfileId":"claude-chat","workspaceId":"ws1"}}"#)
    let write = WriteSessionInput(id: "s1", input: .userMessage(UserMessage(clientMessageId: "m-abc12345", text: "hello")))
    XCTAssertEqual(try ContractJSON.encodeToString(write), #"{"id":"s1","input":{"clientMessageId":"m-abc12345","text":"hello","type":"user_message"}}"#)
    let answer = WriteSessionInput(id: "s1", input: .permissionResponse(PermissionResponse(id: "r1", optionId: "allow-once", answers: ["q1": "A"])))
    XCTAssertEqual(try ContractJSON.encodeToString(answer), #"{"id":"s1","input":{"answers":{"q1":"A"},"id":"r1","optionId":"allow-once","type":"permission_response"}}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(WriteSessionInput(id: "s1", input: .interrupt)), #"{"id":"s1","input":{"type":"interrupt"}}"#)
    let responses: [RequestResponse] = [.permission(optionId: "allow", answers: nil), .permission(optionId: "answer", answers: ["q": "A, B"]), .clarification(answers: ["q": "A"]), .secret(value: "shh"), .dismiss]
    XCTAssertEqual(try responses.map { try ContractJSON.encodeToString($0) }, [
      #"{"optionId":"allow","type":"permission"}"#,
      #"{"answers":{"q":"A, B"},"optionId":"answer","type":"permission"}"#,
      #"{"answers":{"q":"A"},"type":"clarification"}"#,
      #"{"type":"secret","value":"shh"}"#,
      #"{"type":"dismiss"}"#
    ])
    XCTAssertEqual(try ContractJSON.encodeToString(ResolveRequestInput(requestId: "req-1", response: .dismiss)), #"{"requestId":"req-1","response":{"type":"dismiss"}}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(ClientFrame.hello(token: "tok", client: "Clave iOS")), #"{"_tag":"hello","client":"Clave iOS","token":"tok"}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(ClientFrame.subscribe(sessionId: "s1")), #"{"_tag":"subscribe","sessionId":"s1"}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(ClientFrame.ping), #"{"_tag":"ping"}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(PairingRequestInput(idToken: "jwt", clientId: "dcr-1", device: DeviceDescription(name: "clave-native-a", appVersion: "0.1.0"))), #"{"clientId":"dcr-1","device":{"appVersion":"0.1.0","name":"clave-native-a","platform":"ios"},"idToken":"jwt"}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(PrepareFileAttachmentInput(sessionId: "s1", source: .upload(name: "a.png", base64: "AA==", image: true))), #"{"sessionId":"s1","source":{"base64":"AA==","image":true,"kind":"upload","name":"a.png"}}"#)
    XCTAssertEqual(try ContractJSON.encodeToString(PushTokenInput(token: "abcd")), #"{"platform":"ios","token":"abcd"}"#)
  }

  func testDevicesAndRelayAndNotify() throws {
    let ticket = try ContractJSON.decode(PairingTicket.self, from: #"{"pairingId":"p1","expiresAt":1730000600000}"#)
    XCTAssertEqual(ticket.pairingId, "p1")
    let pending = try ContractJSON.decode(PairingRead.self, from: #"{"status":"pending"}"#)
    XCTAssertEqual(pending, PairingRead(status: .pending))
    let approved = try ContractJSON.decode(PairingRead.self, from: #"{"status":"approved","deviceSession":{"token":"t","deviceId":"dev-1","serverId":"srv-1","serverName":"mac"}}"#)
    XCTAssertEqual(approved.deviceSession?.deviceId, "dev-1")
    let device = try ContractJSON.decode(DeviceView.self, from: #"{"id":"dev-1","name":"clave-native-a","platform":"ios","appVersion":"0.1.0","createdAt":1,"lastSeenAt":null}"#)
    XCTAssertNil(device.lastSeenAt)
    let machines = try ContractJSON.decode(MachineList.self, from: #"{"machines":[{"id":"m_1","name":"mac","platform":"macos","version":"1.72.0","online":true,"lastSeen":1730000000000,"direct":[]},{"id":"m_2"}]}"#)
    XCTAssertEqual(machines.machines[0].platform, .macos)
    XCTAssertEqual(machines.machines[1].name, "m_2")
    XCTAssertEqual(machines.machines[1].platform, .unknown)
    XCTAssertFalse(machines.machines[1].online)
    XCTAssertEqual(machineBaseURL(relay: "https://relay.example/", machineId: "m_1"), "https://relay.example/m/m_1")
    XCTAssertEqual(machinePushURL(relay: "https://relay.example", machineId: "m_1"), "https://relay.example/m/m_1/push")
    let payload = try ContractJSON.decode(NotificationPayload.self, from: fixture("notification"))
    XCTAssertEqual(payload.category, .question)
    XCTAssertEqual(payload.category.categoryId, "clave.question")
    XCTAssertEqual(payload.actions, [.reply, .open])
    XCTAssertEqual(NotificationCategory.accountLimit.rawValue, "account_limit")
  }

  func testANotificationPayloadWithoutItsServerNameIsRefused() throws {
    XCTAssertEqual(try ContractJSON.decode(NotificationPayload.self, from: fixture("notification")).serverName, "Valentins-MacBook-Pro")
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("notification")) as? [String: Any])
    XCTAssertNotNil(object.removeValue(forKey: "serverName"))
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    XCTAssertThrowsError(try ContractJSON.decode(NotificationPayload.self, from: data))
    XCTAssertNil(notificationPayload(from: ["clave": String(decoding: data, as: UTF8.self)]))
  }
}
