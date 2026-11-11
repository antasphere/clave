import XCTest

// What the evidence suites share: a screenshot kept twice (attached to the test, and written as a
// PNG under the lane's evidence folder for the lane to read), a pixel read off a screenshot, and
// the walk over the six screens of a paired machine on the in-process fake.

/// Where the evidence goes, outside the repository; the simulator's processes write the host's /private/tmp.
/// `CLAVE_IOS_EVIDENCE_DIR` in the test runner's environment (`TEST_RUNNER_CLAVE_IOS_EVIDENCE_DIR`
/// beside xcodebuild) gives a second runner a folder of its own.
let evidenceRoot = URL(
  fileURLWithPath: ProcessInfo.processInfo.environment["CLAVE_IOS_EVIDENCE_DIR"].flatMap { $0.isEmpty ? nil : $0 }
    ?? "/private/tmp/clave-native-a/evidence",
  isDirectory: true)

/// The six screens an evidence walk visits, in the order it visits them.
enum EvidenceScreen: String, CaseIterable {
  case machines, workspaces, sessions, launch, chat, requests
}

/// One pixel, 0 to 255 per channel.
struct Pixel: Equatable, CustomStringConvertible {
  let red: Int
  let green: Int
  let blue: Int

  var description: String { String(format: "#%02x%02x%02x", red, green, blue) }

  /// The sum of the channels' differences.
  func distance(to other: Pixel) -> Int {
    abs(red - other.red) + abs(green - other.green) + abs(blue - other.blue)
  }

  /// True when no channel is further than `tolerance` from the other pixel's.
  func isWithin(_ tolerance: Int, of other: Pixel) -> Bool {
    abs(red - other.red) <= tolerance && abs(green - other.green) <= tolerance && abs(blue - other.blue) <= tolerance
  }
}

/// The screen's width in points, read once from the running app (one query per read otherwise).
nonisolated(unsafe) private var cachedScreenWidth: CGFloat = 0

private func screenWidthInPoints(fallback: CGFloat) -> CGFloat {
  if cachedScreenWidth == 0 { cachedScreenWidth = XCUIApplication().frame.width }
  return cachedScreenWidth > 0 ? cachedScreenWidth : fallback
}

extension XCTestCase {
  /// The screen as it is now (or only `element`), attached to the test under `name` and written to
  /// `evidence/<topic>/<name>.png`.
  @MainActor
  @discardableResult
  func keepScreenshot(topic: String, name: String, of element: XCUIElement? = nil) -> XCUIScreenshot {
    let shot = element?.screenshot() ?? XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: shot)
    attachment.name = "\(topic)/\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
    let folder = evidenceRoot.appendingPathComponent(topic, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try shot.pngRepresentation.write(to: folder.appendingPathComponent("\(name).png"))
    } catch {
      XCTFail("The screenshot \(topic)/\(name) could not be written: \(error)")
    }
    return shot
  }

  /// A text file beside the screenshots.
  func keepText(_ text: String, topic: String, name: String) {
    let folder = evidenceRoot.appendingPathComponent(topic, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try Data(text.utf8).write(to: folder.appendingPathComponent(name))
    } catch {
      XCTFail("The file \(topic)/\(name) could not be written: \(error)")
    }
  }

  /// The pixel of a screenshot at a point given in the screen's points.
  func pixel(_ shot: XCUIScreenshot, at point: CGPoint) -> Pixel {
    let image = shot.image
    guard let cg = image.cgImage, image.size.width > 0 else {
      XCTFail("The screenshot has no bitmap")
      return Pixel(red: -1, green: -1, blue: -1)
    }
    // The screenshot's bitmap is in pixels; the frames XCUITest gives are in the screen's points.
    let scale = CGFloat(cg.width) / screenWidthInPoints(fallback: image.size.width)
    let x = min(cg.width - 1, max(0, Int(point.x * scale)))
    let y = min(cg.height - 1, max(0, Int(point.y * scale)))
    var bytes = [UInt8](repeating: 0, count: 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      // CoreGraphics counts rows from the bottom: the wanted row lands on the context's only one.
      context.draw(cg, in: CGRect(x: -x, y: y - cg.height + 1, width: cg.width, height: cg.height))
      return true
    }
    XCTAssertTrue(drawn, "No bitmap context for the pixel read")
    return Pixel(red: Int(bytes[0]), green: Int(bytes[1]), blue: Int(bytes[2]))
  }

  /// The ground of the screen: a point in the status bar's left corner, painted by the screen's
  /// own background (the root's, which runs under the safe area).
  func groundPixel(_ shot: XCUIScreenshot) -> Pixel {
    pixel(shot, at: CGPoint(x: 4, y: 4))
  }

  /// The keyboard put away when one is up, by its Done key when it has one, else by a swipe down
  /// (the lists and the transcript let it go that way); fails when it stays.
  @MainActor
  func dismissKeyboard(_ app: XCUIApplication) {
    let keyboard = app.keyboards.firstMatch
    guard keyboard.exists else { return }
    for key in ["done", "Done"] where keyboard.buttons[key].exists {
      keyboard.buttons[key].tap()
      break
    }
    if !keyboard.waitForNonExistence(timeout: 2) { app.swipeDown() }
    XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5), "The keyboard stays up")
  }

  // MARK: navigation

  /// The system back button of the pushed screen on top.
  @MainActor
  func goBack(_ app: XCUIApplication) {
    let back = app.navigationBars.buttons.element(boundBy: 0)
    XCTAssertTrue(back.waitForExistence(timeout: 5), "No back button")
    back.tap()
  }

  /// Back to Machines, the root, whatever is on top.
  @MainActor
  func goToMachines(_ app: XCUIApplication) {
    let appearance = app.buttons["machines.appearance"]
    var steps = 0
    while !(appearance.exists && appearance.isHittable) && steps < 8 {
      goBack(app)
      _ = appearance.waitForExistence(timeout: 2)
      steps += 1
    }
    XCTAssertTrue(appearance.isHittable, "Machines is not on top")
  }

  /// Picks an appearance on the Appearance screen from Machines, and comes back to Machines.
  @MainActor
  func pickAppearance(_ app: XCUIApplication, _ option: String) {
    goToMachines(app)
    app.buttons["machines.appearance"].tap()
    let row = app.buttons["appearance.option.\(option)"]
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.tap()
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: row)
    waitForExpectations(timeout: 5)
    goBack(app)
    XCTAssertTrue(app.buttons["machines.appearance"].waitForExistence(timeout: 5))
  }

  /// The composer's field, a text view when it grows, else a text field.
  @MainActor
  func chatComposerField(_ app: XCUIApplication) -> XCUIElement {
    let view = app.textViews["chat.composer.field"]
    return view.exists ? view : app.textFields["chat.composer.field"]
  }

  /// From Workspaces of `m_fake` into the seeded chat, its last seeded reply on screen.
  @MainActor
  func openSeededChat(_ app: XCUIApplication) {
    let scratch = app.buttons["workspaces.row.scratch"]
    XCTAssertTrue(scratch.waitForExistence(timeout: 10))
    scratch.tap()
    let session = app.buttons["sessions.row.s_fake"]
    XCTAssertTrue(session.waitForExistence(timeout: 10))
    session.tap()
    XCTAssertTrue(element(app, "chat.markdown.code").waitForExistence(timeout: 10), "The seeded chat did not load")
  }

  /// Walks the six screens from Machines and back, calling `visit` on each once it is shown.
  /// Machines must be on top, `m_fake` paired.
  @MainActor
  func walkScreens(_ app: XCUIApplication, _ visit: (EvidenceScreen) -> Void) {
    goToMachines(app)
    XCTAssertTrue(element(app, "machines.row.m_fake").waitForExistence(timeout: 10))
    visit(.machines)

    let open = app.buttons["machines.open.m_fake"]
    // At a large text size the machine's row may sit below the fold (Machines draws its list anew
    // when the text size changes, as an audit does): scroll down to it.
    var swipes = 0
    while !(open.exists && open.isHittable) && swipes < 6 {
      app.swipeUp()
      swipes += 1
    }
    XCTAssertTrue(open.waitForExistence(timeout: 5))
    open.tap()
    XCTAssertTrue(app.buttons["workspaces.row.scratch"].waitForExistence(timeout: 10))
    let state = element(app, "machine.state")
    XCTAssertTrue(state.waitForExistence(timeout: 5))
    expectation(for: NSPredicate(format: "label == 'Connected'"), evaluatedWith: state)
    waitForExpectations(timeout: 10)
    visit(.workspaces)

    app.buttons["workspaces.row.scratch"].tap()
    XCTAssertTrue(app.buttons["sessions.row.s_fake"].waitForExistence(timeout: 10))
    visit(.sessions)

    app.buttons["sessions.new"].tap()
    XCTAssertTrue(element(app, "launch.empty").waitForExistence(timeout: 10))
    visit(.launch)
    goBack(app)

    let session = app.buttons["sessions.row.s_fake"]
    XCTAssertTrue(session.waitForExistence(timeout: 10))
    session.tap()
    XCTAssertTrue(element(app, "chat.markdown.code").waitForExistence(timeout: 10), "The seeded chat did not load")
    visit(.chat)
    goBack(app)
    XCTAssertTrue(app.buttons["sessions.row.s_fake"].waitForExistence(timeout: 5))
    goBack(app)

    let inbox = app.buttons["workspaces.requests"]
    XCTAssertTrue(inbox.waitForExistence(timeout: 10))
    inbox.tap()
    XCTAssertTrue(app.staticTexts["Echo has a question."].waitForExistence(timeout: 10))
    visit(.requests)
    goToMachines(app)
  }
}
