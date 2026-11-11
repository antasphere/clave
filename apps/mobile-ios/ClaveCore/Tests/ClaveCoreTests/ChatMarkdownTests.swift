import XCTest
@testable import ClaveCore

final class ChatMarkdownTests: XCTestCase {
  func testReadsHeadingsAndLeavesInlineMarkdownIntact() {
    XCTAssertEqual(parseMarkdown("## Title\n\nA **bold** word and `code`."), [
      .heading(level: 2, inline: "Title"),
      .paragraph(inline: "A **bold** word and `code`."),
    ])
    XCTAssertEqual(parseMarkdown("# One #\nSetext\n===\nTwo\n---"), [
      .heading(level: 1, inline: "One"),
      .heading(level: 1, inline: "Setext"),
      .heading(level: 2, inline: "Two"),
    ])
    XCTAssertEqual(parseMarkdown("#5 is not a heading"), [.paragraph(inline: "#5 is not a heading")])
  }

  func testKeepsAFenceWithItsLanguageAndAGFMTableWithItsAlignments() {
    let blocks = parseMarkdown("```typescript\nconst ready = true\n```\n\n| File | Status | Size |\n| :--- | :---: | ---: |\n| view.tsx | Ready | 3 |\n| a\\|b | `x|y` |")
    XCTAssertEqual(blocks.count, 2)
    XCTAssertEqual(blocks[0], .code(language: "typescript", text: "const ready = true"))
    XCTAssertEqual(blocks[1], .table(
      header: ["File", "Status", "Size"],
      alignments: [.left, .center, .right],
      rows: [["view.tsx", "Ready", "3"], ["a|b", "`x|y`", ""]]))
  }

  func testATableWithoutOuterPipesAndNoAlignment() {
    XCTAssertEqual(parseMarkdown("a | b\n--- | ---\n1 | 2"), [.table(header: ["a", "b"], alignments: [.none, .none], rows: [["1", "2"]])])
  }

  func testNestedListsByIndentation() {
    let blocks = parseMarkdown("- one\n  - one.a\n  - one.b\n- two\n\n3. three\n4. four")
    XCTAssertEqual(blocks, [
      .list(ordered: false, start: 1, items: [
        [.paragraph(inline: "one"), .list(ordered: false, start: 1, items: [[.paragraph(inline: "one.a")], [.paragraph(inline: "one.b")]])],
        [.paragraph(inline: "two")],
      ]),
      .list(ordered: true, start: 3, items: [[.paragraph(inline: "three")], [.paragraph(inline: "four")]]),
    ])
  }

  func testTaskListsKeepTheirMarkersAndAListItemHoldsAFence() {
    XCTAssertEqual(parseMarkdown("- [x] done\n- [ ] open"), [
      .list(ordered: false, start: 1, items: [[.paragraph(inline: "[x] done")], [.paragraph(inline: "[ ] open")]]),
    ])
    XCTAssertEqual(parseMarkdown("1. run\n   ```sh\n   npm test\n   ```"), [
      .list(ordered: true, start: 1, items: [[.paragraph(inline: "run"), .code(language: "sh", text: "npm test")]]),
    ])
  }

  func testAQuoteHoldsBlocksAndTakesALazyLine() {
    XCTAssertEqual(parseMarkdown("> # Note\n> first\nlazy\n\nafter"), [
      .quote([.heading(level: 1, inline: "Note"), .paragraph(inline: "first lazy")]),
      .paragraph(inline: "after"),
    ])
  }

  func testAnImageOnItsOwnLineARuleAndHTML() {
    XCTAssertEqual(parseMarkdown("![Chart](https://example.com/chart.png)\n\n***\n\n<details>\n<summary>x</summary>\n</details>"), [
      .image(url: "https://example.com/chart.png", alt: "Chart"),
      .rule,
      .html(raw: "<details>\n<summary>x</summary>\n</details>"),
    ])
    XCTAssertEqual(parseMarkdown("See ![a](b.png) inline"), [.paragraph(inline: "See ![a](b.png) inline")])
    XCTAssertEqual(parseMarkdown("<https://example.com> is a link"), [.paragraph(inline: "<https://example.com> is a link")])
  }

  func testSoftBreaksJoinAndHardBreaksStay() {
    XCTAssertEqual(parseMarkdown("one\ntwo  \nthree\\\nfour"), [.paragraph(inline: "one two\nthree\nfour")])
  }

  func testLeavesAnUnfinishedFenceAsCodeWhileAnAnswerStreams() {
    XCTAssertEqual(parseMarkdown("Here:\n\n```bash\nnpm test"), [.paragraph(inline: "Here:"), .code(language: "bash", text: "npm test")])
  }

  func testIndentedCode() {
    XCTAssertEqual(parseMarkdown("text\n\n    let x = 1\n\n    let y = 2\n\nafter"), [
      .paragraph(inline: "text"),
      .code(language: nil, text: "let x = 1\n\nlet y = 2"),
      .paragraph(inline: "after"),
    ])
  }

  func testResolvesCaseInsensitiveReferenceLinksAndImagesTheFirstDefinitionWinning() {
    let blocks = parseMarkdown("[Docs][GUIDE] and [guide]\n\n![Chart][diagram]\n\n[guide]: https://example.com/docs\n[guide]: https://example.com/other\n[diagram]: https://example.com/chart.png\n\n`[guide]` stays code")
    XCTAssertEqual(blocks, [
      .paragraph(inline: "[Docs](https://example.com/docs) and [guide](https://example.com/docs)"),
      .image(url: "https://example.com/chart.png", alt: "Chart"),
      .paragraph(inline: "`[guide]` stays code"),
    ])
  }

  func testTheInlineTextRendersThroughAttributedString() throws {
    guard case .paragraph(let inline) = parseMarkdown("A **bold** word and `code`.")[0] else { return XCTFail() }
    let rendered = try AttributedString(markdown: inline)
    XCTAssertEqual(String(rendered.characters), "A bold word and code.")
  }
}

final class ChatHighlightTests: XCTestCase {
  private let code = "const ready: boolean = true\nconsole.log(\"Ready\") // done\n"

  func testColorsAFenceWhilePreservingAllSourceAndLineEndings() throws {
    let tokens = try XCTUnwrap(highlightCode(code, language: "typescript"))
    XCTAssertEqual(tokens.map { $0.map(\.text).joined() }.joined(separator: "\n"), code)
    XCTAssertGreaterThan(Set(tokens.flatMap { $0.map(\.kind) }).count, 2)
    let block = try XCTUnwrap(highlightCode("a /* one\ntwo */ b", language: "js"))
    XCTAssertEqual(block[1].first, CodeToken("two */", .comment))
  }

  func testUsesTheSameTwoCodePalettesAsDesktopAcrossTheFourThemes() {
    XCTAssertEqual(CodePalette(theme: "light"), .light)
    XCTAssertEqual(CodePalette(theme: "coffee"), .light)
    XCTAssertEqual(CodePalette(theme: "dark"), .dark)
    XCTAssertEqual(CodePalette(theme: "charcoal"), .dark)
  }

  func testLeavesUnknownAndUnlabelledCodePlain() {
    XCTAssertNil(highlightCode(code, language: nil))
    XCTAssertNil(highlightCode(code, language: "not-a-language"))
    XCTAssertNil(highlightCode(code, language: "constructor"))
  }

  func testADiffColorsItsLines() throws {
    let lines = try XCTUnwrap(highlightCode("@@ -1 +1 @@\n- a\n+ b", language: "diff"))
    XCTAssertEqual(lines.map { $0.first?.kind }, [.meta, .deleted, .inserted])
  }
}
