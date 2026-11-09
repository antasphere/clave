import XCTest
@testable import ClaveCore

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

  func testAttachmentDraftsKeepTheListAndClearOnlyTheOneSent() async throws {
    let store = InMemoryKeyValueStore()
    let drafts = AttachmentDrafts(store: store)
    let one = Attachment.file(FileAttachment(id: "f-1", label: "Image #1", path: "/a.png", name: "a.png", mimeType: "image/png", size: 3, delivery: .image))
    let two = Attachment.file(FileAttachment(id: "f-2", label: "File #1", path: "/b.txt", name: "b.txt", mimeType: "text/plain", size: 3, delivery: .reference))
    try await drafts.set("m", "s", [one])
    let kept = try await AttachmentDrafts(store: store).get("m", "s")
    XCTAssertEqual(kept, [one])
    try await drafts.set("m", "s", [one, two])
    try await drafts.clearIfUnchanged("m", "s", sent: [one])
    let afterMismatch = try await drafts.get("m", "s")
    XCTAssertEqual(afterMismatch, [one, two])
    try await drafts.clearIfUnchanged("m", "s", sent: [one, two])
    let values = await store.values
    XCTAssertNil(values[attachmentDraftKey("m", "s")])
    XCTAssertEqual(attachmentDraftKey("m", "s"), "clave.attachment-draft:m:s")
  }

  func testTwoOwnersDraftsAndLedgersNeverCollideOverOneSharedStore() async throws {
    let base = InMemoryKeyValueStore()
    let namespaceA = ownerNamespace(issuer: "https://team.antasphere.com", subject: "owner-a")
    let namespaceB = ownerNamespace(issuer: "https://team.antasphere.com", subject: "owner-b")
    let ownerA = OwnerScopedKeyValueStore(base: base, namespace: namespaceA)
    let ownerB = OwnerScopedKeyValueStore(base: base, namespace: namespaceB)
    let send = UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-a", text: "from A", at: 1)
    let mark = DeliveryMark(kind: .unknown, clientMessageId: "message-a", reason: "r", at: 1)
    let file = Attachment.file(FileAttachment(id: "f", path: "/a", name: "a", mimeType: "text/plain", size: 1, delivery: .reference))

    try await Drafts(store: ownerA).set("m", "s", "A's draft")
    try await UnknownSends(store: ownerA).add(send)
    try await DeliveryMarks(store: ownerA).set("m", "s", mark)
    try await AttachmentDrafts(store: ownerA).set("m", "s", [file])

    let draftB = try await Drafts(store: ownerB).get("m", "s")
    let sendsB = try await UnknownSends(store: ownerB).list()
    let markB = try await DeliveryMarks(store: ownerB).get("m", "s")
    let filesB = try await AttachmentDrafts(store: ownerB).get("m", "s")
    XCTAssertEqual(draftB, "")
    XCTAssertEqual(sendsB, [])
    XCTAssertNil(markB)
    XCTAssertEqual(filesB, [])

    try await Drafts(store: ownerB).set("m", "s", "B's draft")
    try await UnknownSends(store: ownerB).add(UnknownSend(machineId: "m", sessionId: "s", clientMessageId: "message-b", text: "from B", at: 2))
    let draftA = try await Drafts(store: ownerA).get("m", "s")
    let sendsA = try await UnknownSends(store: ownerA).list()
    XCTAssertEqual(draftA, "A's draft")
    XCTAssertEqual(sendsA, [send])

    let keys = Set(await base.values.keys)
    for key in [draftKey("m", "s"), UnknownSends.key] {
      XCTAssertTrue(keys.contains("\(namespaceA):\(key)"), key)
      XCTAssertTrue(keys.contains("\(namespaceB):\(key)"), key)
    }
    XCTAssertTrue(keys.contains("\(namespaceA):\(deliveryMarkKey("m", "s"))"))
    XCTAssertFalse(keys.contains(draftKey("m", "s")), "nothing is written outside a namespace")
  }
}
