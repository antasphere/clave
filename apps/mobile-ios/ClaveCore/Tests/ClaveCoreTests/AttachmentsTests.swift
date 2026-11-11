import XCTest
@testable import ClaveCore

final class AttachmentsTests: XCTestCase {
  private var record: FileAttachment { Self.record }
  private let file = PickedFile(uri: "file:///photo.png", name: "photo.png", mimeType: "image/png", size: 3, kind: .image)
  private let context = AdmissionContext(imagesSupported: true, filesRoute: true)
  private static let record = FileAttachment(id: "f-1", path: "/tmp/session/attachments/photo.png", name: "photo.png", mimeType: "image/png", size: 3, delivery: .image)

  private func sized(_ size: Int?) -> PickedFile {
    var copy = file
    copy.size = size
    return copy
  }

  func testAdmitsImagesWithinTheProviderAndTransferLimits() {
    XCTAssertEqual(admit(file, context), .accepted(image: true, note: nil))
    XCTAssertEqual(admit(sized(maxTransferBytes), context), .accepted(image: true, note: nil))
  }

  func testRefusesAnInvalidUnknownOrOversizedSize() {
    for size in [0, -1, maxTransferBytes + 1, nil] {
      guard case .refused = admit(sized(size), context) else { return XCTFail("\(String(describing: size))") }
    }
    XCTAssertEqual(admit(sized(nil), context), .refused(reason: "The size of photo.png is not known, so it cannot be sent."))
    XCTAssertEqual(admit(sized(maxTransferBytes + 1), context), .refused(reason: "photo.png is 5 MiB; the beta sends files of 5 MiB at most."))
  }

  func testRefusesExcessRecordsAndTotalImageBytes() {
    var full = context
    full.count = maxAttachments
    XCTAssertEqual(admit(file, full), .refused(reason: "Attach up to 10 files per message."))
    var heavy = context
    heavy.imageBytes = 20 * 1024 * 1024
    XCTAssertEqual(admit(file, heavy), .refused(reason: "Pictures in one message must total 20 MiB or less."))
    XCTAssertEqual(maxImageBytes, 5 * 1024 * 1024)
    XCTAssertEqual(maxTotalImageBytes, 20 * 1024 * 1024)
  }

  func testAMissingFilesRouteRefusesExplicitly() {
    guard case .refused(let reason) = admit(file, AdmissionContext(imagesSupported: true, filesRoute: false)) else { return XCTFail() }
    XCTAssertTrue(reason.contains("cannot take files"))
  }

  func testHEICVideoAndAProviderWithoutImagesTravelAsReferencesWithTheirExplanation() {
    var heic = file
    heic.mimeType = "image/heic"
    var video = file
    video.mimeType = "video/mp4"
    video.kind = .video
    for picked in [heic, video] {
      guard case .accepted(false, let note?) = admit(picked, context) else { return XCTFail(picked.mimeType) }
      XCTAssertFalse(note.isEmpty)
    }
    XCTAssertEqual(admit(file, AdmissionContext(capabilities: SessionCapabilities(images: false), filesRoute: true)), .accepted(image: false, note: "Sent as a file, not as a picture: this agent does not take pictures directly."))
    for mime in ["image/jpeg", "image/gif", "image/webp"] {
      var picture = file
      picture.mimeType = mime
      XCTAssertEqual(admit(picture, context), .accepted(image: true, note: nil), mime)
    }
  }

  func testMediaTypesFromNames() {
    XCTAssertEqual(mimeTypeOf("dir/Photo.JPG"), "image/jpeg")
    XCTAssertEqual(mimeTypeOf("clip.mov"), "video/quicktime")
    XCTAssertEqual(mimeTypeOf(".hidden"), "application/octet-stream")
    XCTAssertEqual(mimeTypeOf("notes"), "application/octet-stream")
    XCTAssertEqual(kindOf("image/heic"), .image)
    XCTAssertEqual(kindOf("video/mp4"), .video)
    XCTAssertEqual(kindOf("text/plain"), .file)
  }

  func testUploadsTheBytesAndLabelsTheReturnedRecordPreservingTheMessageId() async throws {
    let result = await prepareAttachment(file, sessionId: "s-1", current: [],
      readBase64: { _ in "YWJj" },
      prepareUpload: { id, name, base64, image in
        XCTAssertEqual(id, "s-1")
        XCTAssertEqual(name, "photo.png")
        XCTAssertEqual(base64, "YWJj")
        XCTAssertTrue(image)
        return Self.record
      },
      imagesSupported: true, filesRoute: true)
    guard case .prepared(let labelledRecord, nil) = result else { return XCTFail("\(result)") }
    XCTAssertEqual(labelledRecord.label, "Image #1")
    let message = try buildUserMessage("Look", [.file(labelledRecord)], clientMessageId: "message-1234")
    XCTAssertEqual(message, UserMessage(clientMessageId: "message-1234", text: "Look [Image #1]", attachments: [.file(labelledRecord)]))
    XCTAssertEqual(try buildUserMessage("Look [Image #1]", [.file(labelledRecord)]).text, "Look [Image #1]")
    XCTAssertEqual(try buildUserMessage("", [.file(labelledRecord)]).text, "[Image #1]")
    XCTAssertNil(try buildUserMessage("plain", []).attachments)
  }

  func testChecksTheActualBytesBeforeUploadEvenIfThePickerUnderstatedTheSize() async {
    let uploaded = Box(false)
    let big = String(repeating: "A", count: 4 * ((maxTransferBytes + 3 + 2) / 3))
    let result = await prepareAttachment(file, sessionId: "s-1", current: [],
      readBase64: { _ in big },
      prepareUpload: { _, _, _, _ in uploaded.value = true; return Self.record },
      imagesSupported: true, filesRoute: true)
    guard case .refused = result else { return XCTFail() }
    XCTAssertFalse(uploaded.value)
  }

  func testNumbersPerKindWithoutReusingRemovedLabelsAndSurfacesARefusedUpload() async {
    let four = FileAttachment(id: "f-0", label: "Image #4", path: "/p", name: "p.png", mimeType: "image/png", size: 3, delivery: .image)
    let result = await prepareAttachment(file, sessionId: "s-1", current: [.file(four)],
      readBase64: { _ in "YWJj" }, prepareUpload: { _, _, _, _ in Self.record },
      imagesSupported: true, filesRoute: true)
    guard case .prepared(let next, _) = result else { return XCTFail() }
    XCTAssertEqual(next.label, "Image #5")
    let doc = FileAttachment(id: "f-2", path: "/n.txt", name: "n.txt", mimeType: "text/plain", size: 1, delivery: .reference)
    XCTAssertEqual(labelled(doc, [.file(four)]).label, "File #1")
    let refused = await prepareAttachment(file, sessionId: "s-1", current: [],
      readBase64: { _ in "YWJj" }, prepareUpload: { _, _, _, _ in throw ServerError(.refused, "Upload unavailable") },
      imagesSupported: true, filesRoute: true)
    XCTAssertEqual(refused, .refused(reason: "photo.png was not sent: Upload unavailable"))
    let unavailable = await prepareAttachment(file, sessionId: "s-1", current: [],
      readBase64: { _ in "YWJj" },
      prepareUpload: { _, _, _, _ in throw ServerError(.refused, "No files.", failure: ServerFailure(tag: "CapabilityUnavailable", message: "No files.")) },
      imagesSupported: true, filesRoute: true)
    XCTAssertEqual(unavailable, .refused(reason: noFilesRouteReason))
  }

  func testMoreThanTenRecordsCannotBuildAMessage() {
    let many = (0..<11).map { Attachment.file(FileAttachment(id: "f-\($0)", path: "/p", name: "p", mimeType: "text/plain", size: 1, delivery: .reference)) }
    XCTAssertThrowsError(try buildUserMessage("x", many))
    XCTAssertEqual(base64Bytes("YWJj"), 3)
    XCTAssertEqual(base64Bytes("YQ=="), 1)
  }
}
