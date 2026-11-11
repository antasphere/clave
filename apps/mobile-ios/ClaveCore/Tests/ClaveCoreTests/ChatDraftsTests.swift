import XCTest
@testable import ClaveCore

/// A file as the picker hands it over, under the app's own folder by default.
private func picked(_ name: String, at uri: String? = nil, mimeType: String = "text/plain", kind: PickedKind = .file) -> PickedFile {
  PickedFile(uri: uri ?? "file:///picked/\(name)", name: name, mimeType: mimeType, size: 12, kind: kind)
}

final class ChatDraftsTests: XCTestCase {
  func testDraftsSurviveANewInstanceOverTheSameStorePerMachineAndSession() async throws {
    let store = InMemoryKeyValueStore()
    let drafts = Drafts(store: store)
    try await drafts.set("m1", "s1", "half a thought")
    try await drafts.set("m1", "s2", "another")
    let again = Drafts(store: store)
    let first = try await again.get("m1", "s1")
    let second = try await again.get("m1", "s2")
    let none = try await again.get("m2", "s1")
    XCTAssertEqual(first, "half a thought")
    XCTAssertEqual(second, "another")
    XCTAssertEqual(none, "")
  }

  func testAnEmptyTextRemovesTheDraftFromTheStore() async throws {
    let store = InMemoryKeyValueStore()
    let drafts = Drafts(store: store)
    try await drafts.set("m1", "s1", "x")
    var values = await store.values
    XCTAssertNotNil(values[draftKey("m1", "s1")])
    XCTAssertEqual(draftKey("m1", "s1"), "clave.draft:m1:s1")
    try await drafts.clear("m1", "s1")
    values = await store.values
    XCTAssertNil(values[draftKey("m1", "s1")])
    let cleared = try await drafts.get("m1", "s1")
    XCTAssertEqual(cleared, "")
  }

  func testAttachmentDraftsKeepTheListAndADeliveryTakesOffOnlyTheFilesItCarried() async throws {
    let store = InMemoryKeyValueStore()
    let drafts = AttachmentDrafts(store: store)
    let one = picked("a.png", mimeType: "image/png", kind: .image)
    let two = picked("b.txt")
    try await drafts.set("m", "s", [one])
    let kept = try await AttachmentDrafts(store: store).get("m", "s")
    XCTAssertEqual(kept, [one])
    try await drafts.set("m", "s", [one, two])
    try await drafts.removeSent("m", "s", files: [one])
    let afterOne = try await drafts.get("m", "s")
    XCTAssertEqual(afterOne, [two], "the file picked since stays")
    try await drafts.removeSent("m", "s", files: [two])
    let values = await store.values
    XCTAssertNil(values[attachmentDraftKey("m", "s")])
    XCTAssertEqual(attachmentDraftKey("m", "s"), "clave.attachment-draft:m:s")
  }

  /// A delivery names the files it carried by their address: a file picked again since under the
  /// same name stays, and the one sent goes even if the record describes it otherwise.
  func testADeliveryTakesItsFilesOffByTheirAddress() async throws {
    let drafts = AttachmentDrafts(store: InMemoryKeyValueStore())
    let sent = picked("notes.txt", at: "file:///picked/1-notes.txt")
    let again = picked("notes.txt", at: "file:///picked/2-notes.txt")
    try await drafts.set("m", "s", [sent, again])
    try await drafts.set("m", "other", [sent])
    let described = PickedFile(uri: sent.uri, name: "renamed.txt", mimeType: "text/plain", size: 99, kind: .file)
    try await drafts.removeSent("m", "s", files: [described])
    let kept = try await drafts.get("m", "s")
    XCTAssertEqual(kept, [again])
    let other = try await drafts.get("m", "other")
    XCTAssertEqual(other, [sent], "another conversation's list is untouched")
  }

  /// The list goes from the store with the last file a delivery takes off, and a delivery over no
  /// list writes nothing.
  func testTheListLeavesTheStoreWithTheLastFileADeliveryTakesOff() async throws {
    let store = InMemoryKeyValueStore()
    let drafts = AttachmentDrafts(store: store)
    let file = picked("only.txt")
    try await drafts.set("m", "s", [file])
    try await drafts.removeSent("m", "s", files: [file])
    var values = await store.values
    XCTAssertNil(values[attachmentDraftKey("m", "s")], "the key is removed")
    try await drafts.removeSent("m", "s", files: [file])
    values = await store.values
    XCTAssertTrue(values.isEmpty, "nothing written")
  }

  /// A composer's save made while a delivery's read-modify-write of the list is held between its
  /// read and its write is kept: the two run one after the other, the delivery first.
  func testASaveMadeWhileADeliveryTakesItsFilesOffIsKept() async throws {
    let store = ReadHoldingStore()
    let drafts = AttachmentDrafts(store: store)
    let a = picked("a.txt"), b = picked("b.txt"), c = picked("c.txt")
    try await drafts.set("m", "s", [a, b])
    await store.holdNextRead(of: attachmentDraftKey("m", "s"))
    let delivery = Task { try await drafts.removeSent("m", "s", files: [a]) }
    await eventually("the delivery holds between its read and its write") { await store.waiting == 1 }
    let save = Task { try await drafts.set("m", "s", [b, c]) }
    // The save is issued while the delivery is held.
    try await Task.sleep(nanoseconds: 100_000_000)
    await store.release()
    try await delivery.value
    try await save.value
    let kept = try await drafts.get("m", "s")
    XCTAssertEqual(kept, [b, c], "the save made meanwhile is kept")
  }

  // MARK: - What a delivery leaves in the field

  func testAFieldThatIsStillTheTextSentIsEmptyAfterTheDelivery() {
    XCTAssertEqual(draftAfterDelivery("Please add a test.", sent: "Please add a test."), "")
  }

  func testTextAddedAfterTheTextSentStaysWithoutTheSpaceBeforeIt() {
    XCTAssertEqual(draftAfterDelivery("Please add a test. addition", sent: "Please add a test."), "addition")
  }

  func testALineAddedAfterTheTextSentStaysWithoutTheLineBreak() {
    XCTAssertEqual(draftAfterDelivery("Please add a test.\nnew line", sent: "Please add a test."), "new line")
  }

  func testAFieldThatNoLongerStartsWithTheTextSentStaysAsItIs() {
    XCTAssertEqual(draftAfterDelivery("A new thought.", sent: "Please add a test."), "A new thought.")
  }

  /// No text of the field was sent (files alone): everything in it was added since, as typed.
  func testWithNoTextSentTheFieldStaysAsItIs() {
    XCTAssertEqual(draftAfterDelivery("  typed since", sent: ""), "  typed since")
    XCTAssertEqual(draftAfterDelivery("", sent: ""), "")
  }

  /// A send keeps the files the person picked for it, under "files" with the picker's own keys; a
  /// list this build cannot read is none.
  func testASendKeepsThePickedFilesItCarriedAndAnUnreadableListIsNone() throws {
    let file = picked("a.txt")
    XCTAssertEqual(
      try encodeStored(file),
      #"{"kind":"file","mimeType":"text/plain","name":"a.txt","size":12,"uri":"file:///picked/a.txt"}"#)
    let send = UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-files", text: "t", at: 1, files: [file])
    let stored = try encodeStored(send)
    XCTAssertEqual(try JSONDecoder().decode(UnknownSend.self, from: Data(stored.utf8)), send)
    let unreadable = #"{"machineId":"m","sessionId":"s","clientMessageId":"message-files","text":"t","at":1,"files":[{"uri":1}]}"#
    let read = try JSONDecoder().decode(UnknownSend.self, from: Data(unreadable.utf8))
    XCTAssertNil(read.files)
    XCTAssertEqual(read.clientMessageId, "message-files", "the send is still one to ask about")
  }

  func testTwoOwnersDraftsAndLedgersNeverCollideOverOneSharedStore() async throws {
    let base = InMemoryKeyValueStore()
    let namespaceA = ownerNamespace(issuer: "https://team.antasphere.com", subject: "owner-a")
    let namespaceB = ownerNamespace(issuer: "https://team.antasphere.com", subject: "owner-b")
    let ownerA = OwnerScopedKeyValueStore(base: base, namespace: namespaceA)
    let ownerB = OwnerScopedKeyValueStore(base: base, namespace: namespaceB)
    let send = UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-a", text: "from A", at: 1)
    let mark = DeliveryMark(kind: .unknown, clientMessageId: "message-a", reason: "r", at: 1)
    let file = PickedFile(uri: "file:///a", name: "a", mimeType: "text/plain", size: 1, kind: .file)

    try await Drafts(store: ownerA).set("m", "s", "A's draft")
    try await UnknownSends(store: ownerA, machineId: "m").add(send)
    try await DeliveryMarks(store: ownerA).set("m", "s", mark)
    try await AttachmentDrafts(store: ownerA).set("m", "s", [file])

    let draftB = try await Drafts(store: ownerB).get("m", "s")
    let sendsB = try await UnknownSends(store: ownerB, machineId: "m").list()
    let markB = try await DeliveryMarks(store: ownerB).get("m", "s")
    let filesB = try await AttachmentDrafts(store: ownerB).get("m", "s")
    XCTAssertEqual(draftB, "")
    XCTAssertEqual(sendsB, [])
    XCTAssertNil(markB)
    XCTAssertEqual(filesB, [])

    try await Drafts(store: ownerB).set("m", "s", "B's draft")
    try await UnknownSends(store: ownerB, machineId: "m").add(UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-b", text: "from B", at: 2))
    let draftA = try await Drafts(store: ownerA).get("m", "s")
    let sendsA = try await UnknownSends(store: ownerA, machineId: "m").list()
    XCTAssertEqual(draftA, "A's draft")
    XCTAssertEqual(sendsA, [send])

    let keys = Set(await base.values.keys)
    for key in [draftKey("m", "s"), UnknownSends.key(for: "m")] {
      XCTAssertTrue(keys.contains("\(namespaceA):\(key)"), key)
      XCTAssertTrue(keys.contains("\(namespaceB):\(key)"), key)
    }
    XCTAssertTrue(keys.contains("\(namespaceA):\(deliveryMarkKey("m", "s"))"))
    XCTAssertFalse(keys.contains(draftKey("m", "s")), "nothing is written outside a namespace")
  }
}
