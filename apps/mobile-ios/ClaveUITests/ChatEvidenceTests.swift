import XCTest

/// Evidence B, E and G on the seeded chat of the in-process fake: the GitHub-flavoured reply the
/// fake seeds last, the two kinds of turn, the composer with the keyboard up, and the Stop button
/// over a turn the fake holds until it is interrupted.
final class ChatEvidenceTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// A turn by its identifier's prefix and its words: the person's turn is one element whose label
  /// holds them, the agent's a group of its drawn blocks, one of which holds them.
  @MainActor
  private func turn(_ app: XCUIApplication, _ prefix: String, containing text: String) -> XCUIElement {
    let words = NSPredicate(format: "label CONTAINS %@", text)
    let turns = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix))
    return prefix == "chat.assistant." ? turns.containing(words).firstMatch : turns.matching(words).firstMatch
  }

  // MARK: B: the Markdown

  @MainActor
  func testTheMarkdownReplyRendersInDarkAndLight() {
    let app = signInAndPair()
    for theme in ["dark", "light"] {
      pickAppearance(app, theme)
      app.buttons["machines.open.m_fake"].tap()
      openSeededChat(app)

      // The heading is a header of its own, its words without the hashes.
      let heading = app.staticTexts["Evidence heading"]
      XCTAssertTrue(heading.waitForExistence(timeout: 5))
      XCTAssertTrue(heading.isHittable)

      // The fenced block: its language, its three lines, in the one element VoiceOver reads.
      let code = element(app, "chat.markdown.code")
      XCTAssertEqual(code.label, "Code, swift")
      let source = code.value as? String ?? ""
      XCTAssertTrue(source.contains("let greeting = \"hello\""), source)
      XCTAssertTrue(source.contains("print(greeting, count)"), source)
      XCTAssertEqual(source.split(separator: "\n").count, 3, source)

      keepText(app.debugDescription, topic: "chat", name: "tree-\(theme).txt")
      // The table: the header row and the two rows, cell by cell.
      let table = element(app, "chat.markdown.table")
      XCTAssertTrue(table.exists)
      for cell in ["Name", "Value", "alpha", "1", "beta", "2"] {
        XCTAssertTrue(table.staticTexts[cell].exists, "The table has no cell \(cell)")
      }

      // The link's paragraph, read with the link's words; iOS 17.5 gives the link no element of
      // its own in the tree (`links` is empty), so its accent and underline are the screenshot's.
      XCTAssertTrue(app.staticTexts["A paragraph with a link to Clave."].exists)

      // The image of the data: URL, drawn: 16 by 2 pixels fitted to the column, not the
      // 24-point placeholder of a failure nor the spinner of a load.
      let image = element(app, "chat.markdown.image")
      XCTAssertTrue(image.exists)
      XCTAssertEqual(image.label, "A tiny strip")
      XCTAssertGreaterThan(image.frame.height, 30, "\(image.frame)")
      XCTAssertEqual(image.frame.width / image.frame.height, 8, accuracy: 0.5, "\(image.frame)")

      keepScreenshot(topic: "chat", name: "gfm-\(theme)")
      goToMachines(app)
    }
  }

  @MainActor
  func testThePersonsTurnIsBoxedAndTheAgentsIsOnTheGround() {
    let app = signInAndPair()
    pickAppearance(app, "dark")
    app.buttons["machines.open.m_fake"].tap()
    openSeededChat(app)
    let transcript = element(app, "chat.transcript")
    XCTAssertTrue(transcript.exists)
    let user = turn(app, "chat.user.", containing: "seeded-fake")
    let agent = turn(app, "chat.assistant.", containing: "seeded-fake")
    // The seeded turns sit above the Markdown reply: the transcript is read from its top.
    if !(user.exists && user.isHittable) { transcript.swipeDown() }
    XCTAssertTrue(user.waitForExistence(timeout: 5))
    XCTAssertTrue(agent.waitForExistence(timeout: 5))
    XCTAssertTrue(user.isHittable)
    XCTAssertTrue(agent.isHittable)

    // The person's turn sits at the trailing end, the agent's at the leading one.
    let width = app.frame.width
    XCTAssertGreaterThan(user.frame.minX, width / 2, "\(user.frame)")
    XCTAssertLessThan(agent.frame.minX, 24, "\(agent.frame)")

    let shot = keepScreenshot(topic: "chat", name: "turns")
    let ground = groundPixel(shot)
    // The person's turn is a box: down the column just inside its trailing edge, one fill other
    // than the ground runs for at least 20 points. The column is read whole, the frame's vertical
    // position being testTheTranscriptsFramesLieOnItsDrawing's to prove.
    let column = user.frame.maxX - 8
    var run = 0, longest = 0, fill = ground, top: CGFloat = 0
    var y: CGFloat = 100
    while y < app.frame.height - 120 {
      let here = pixel(shot, at: CGPoint(x: column, y: y))
      if here != ground && here == fill {
        run += 1
      } else {
        run = here != ground ? 1 : 0
        fill = here
        if run == 1 { top = y }
      }
      if run > longest { longest = run }
      if longest >= 20 { break }
      y += 1
    }
    XCTAssertGreaterThanOrEqual(longest, 20, "No box at x \(column): the longest run was \(longest) points")
    keepText(
      "ground \(ground)\nuser turn \(user.identifier) frame \(user.frame)\n"
        + "box fill \(fill) found at x \(column) from y \(top) (frame says y \(user.frame.minY))\n"
        + "assistant turn \(agent.identifier) frame \(agent.frame)\n",
      topic: "chat", name: "turns.txt")
  }

  // MARK: the transcript's frames on its drawing

  /// Where VoiceOver and the audit find the turns is where they are drawn. On the seeded chat as it
  /// opens, at the latest, in the dark theme: every turn's frame lies inside the transcript's, the
  /// pixel just inside the leading edge of the person's turn is its box's fill, and the pixel just
  /// above that turn is the ground. iOS 17.5 put these frames about 80 points below the drawing.
  @MainActor
  func testTheTranscriptsFramesLieOnItsDrawing() {
    let app = signInAndPair()
    pickAppearance(app, "dark")
    app.buttons["machines.open.m_fake"].tap()
    openSeededChat(app)
    let transcript = element(app, "chat.transcript")
    XCTAssertTrue(transcript.waitForExistence(timeout: 5))
    let user = turn(app, "chat.user.", containing: "seeded-fake")
    XCTAssertTrue(user.waitForExistence(timeout: 5))

    let area = transcript.frame
    var lines = ["transcript \(area)"]
    var outside: [String] = []
    let turns = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'chat.user.' OR identifier BEGINSWITH 'chat.assistant.'"))
      .allElementsBoundByIndex
    XCTAssertFalse(turns.isEmpty, "No turn in the transcript")
    for each in turns {
      let frame = each.frame
      let inside = area.insetBy(dx: -0.5, dy: -0.5).contains(frame)
      lines.append("\(each.identifier) \(frame) \(inside ? "inside" : "OUTSIDE") the transcript")
      if !inside { outside.append("\(each.identifier) \(frame)") }
    }

    let frame = user.frame
    let shot = keepScreenshot(topic: "chat", name: "transcript-frames")
    let fill = Pixel(red: 0x16, green: 0x15, blue: 0x13)
    let ground = Pixel(red: 0x0e, green: 0x0d, blue: 0x0c)
    let insideEdge = CGPoint(x: frame.minX + 4, y: frame.midY)
    let aboveTop = CGPoint(x: frame.minX + 4, y: frame.minY - 4)
    let inBox = pixel(shot, at: insideEdge)
    let overBox = pixel(shot, at: aboveTop)
    lines.append("\(user.identifier) frame \(frame)")
    lines.append("pixel inside the leading edge at \(insideEdge): \(inBox) (box fill \(fill))")
    lines.append("pixel above the top at \(aboveTop): \(overBox) (ground \(ground))")
    keepText(lines.joined(separator: "\n") + "\n", topic: "chat", name: "transcript-frames.txt")

    XCTAssertTrue(outside.isEmpty, "Turns outside the transcript \(area): \(outside.joined(separator: ", "))")
    XCTAssertTrue(inBox.isWithin(3, of: fill), "Inside the person's turn at \(insideEdge) is \(inBox), not the box's \(fill)")
    XCTAssertTrue(overBox.isWithin(3, of: ground), "Above the person's turn at \(aboveTop) is \(overBox), not the ground \(ground)")
  }

  // MARK: E: the composer

  @MainActor
  func testAThreeLineMessageGrowsTheFieldAndIsSent() {
    let app = signInAndPair()
    openSeededChat(app)
    let field = chatComposerField(app)
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    let before = field.frame.height
    field.tap()
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "No software keyboard")
    // The reader was at the latest: the keyboard leaves the transcript's last block in view.
    let latest = element(app, "chat.markdown.image")
    XCTAssertTrue(latest.isHittable, "The latest block is under the keyboard at \(latest.frame)")

    let marker = "composer-\(Int(Date().timeIntervalSince1970))"
    field.typeText("\(marker) one\nline two\nline three")
    let grown = chatComposerField(app)
    XCTAssertGreaterThan(grown.frame.height, before + 20, "before \(before), after \(grown.frame.height)")
    let send = app.buttons["chat.composer.send"]
    XCTAssertTrue(send.isEnabled)
    XCTAssertTrue(send.isHittable)
    keepScreenshot(topic: "chat", name: "composer-keyboard")
    keepText("field height before \(before), with three lines \(grown.frame.height)\n", topic: "chat", name: "composer.txt")

    send.tap()
    let echo = turn(app, "chat.assistant.", containing: "line three")
    XCTAssertTrue(echo.waitForExistence(timeout: 15))
    XCTAssertTrue(echo.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\(marker) one")).firstMatch.exists)
    // The draft is cleared once the server accepted it: the field is back to its prompt.
    expectation(for: NSPredicate(format: "isEnabled == false"), evaluatedWith: app.buttons["chat.composer.send"])
    waitForExpectations(timeout: 5)
    let value = chatComposerField(app).value as? String ?? ""
    XCTAssertTrue(value.isEmpty || value == "Message", "The field still holds \(value)")
  }

  // MARK: G: the Stop button

  @MainActor
  func testAHeldTurnShowsStopAndStopsOnTap() {
    let app = signInAndPair()
    openSeededChat(app)
    let field = chatComposerField(app)
    field.tap()
    let text = "slow: wait \(Int(Date().timeIntervalSince1970))"
    field.typeText(text)
    let sent = Date()
    app.buttons["chat.composer.send"].tap()

    let stop = app.buttons["chat.interrupt"]
    XCTAssertTrue(stop.waitForExistence(timeout: 10), "The header shows no Stop button")
    let shown = Date()
    XCTAssertEqual(stop.label, "Stop the agent")
    // The fake holds the reply: none is there while the agent works.
    XCTAssertFalse(turn(app, "chat.assistant.", containing: text).exists)
    keepScreenshot(topic: "chat", name: "working-stop")

    stop.tap()
    let tapped = Date()
    let echo = turn(app, "chat.assistant.", containing: text)
    XCTAssertTrue(echo.waitForExistence(timeout: 10))
    let echoed = Date()
    // Well inside the fake's own 20 s release: the interrupt is what answered.
    XCTAssertLessThan(echoed.timeIntervalSince(tapped), 10)
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: stop)
    waitForExpectations(timeout: 5)
    let gone = Date()
    keepText(
      String(
        format: "send to Stop shown %.2f s\nStop shown to tap %.2f s\ntap to echo %.2f s\ntap to Stop gone %.2f s\n",
        shown.timeIntervalSince(sent), tapped.timeIntervalSince(shown), echoed.timeIntervalSince(tapped),
        gone.timeIntervalSince(tapped)),
      topic: "chat", name: "working-stop.txt")
  }
}
