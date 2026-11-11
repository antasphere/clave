import XCTest
@testable import ClaveCore

final class LaunchChoicesTests: XCTestCase {
  private func profile(_ id: String, _ name: String, _ family: LauncherFamily = .claude, builtIn: Bool? = nil, source: String? = nil, pi: PiProfileSettings? = nil) -> LaunchProfileView {
    LaunchProfileView(id: id, name: name, family: family, command: [family.rawValue], additionalArgs: ["--flag"], builtIn: builtIn, sourceProfileId: source, pi: pi)
  }

  private let workspace = WorkspaceView(id: "w-1", name: "Project", rootDir: "/Users/v/project", createdAt: 1)

  func testOffersChatProfilesFirstThenByNameWithoutTheTerminalBuiltIns() {
    let preferences = LaunchProfilePreferencesView(customProfiles: [
      profile("builtin-claude", "Claude", builtIn: true),
      profile("work", "Work Claude"),
      profile("chat:codex:fast", "Fast (chat)", .codex, source: "fast"),
      profile("builtin-pi", "Pi", .pi, builtIn: true),
      profile("claude-chat", "Claude (chat)"),
      profile("alpha", "Alpha", .codex),
      profile("dev-echo-adapter", "Echo"),
    ], globalDefaults: [:], workspaceOverrides: [:])
    XCTAssertEqual(launchChoices(preferences).map(\.id), ["claude-chat", "dev-echo-adapter", "chat:codex:fast", "alpha", "work"])
    XCTAssertTrue(isChatProfile(profile("codex-chat", "Codex (chat)", .codex)))
    XCTAssertFalse(isChatProfile(profile("work", "Work")))
  }

  func testTheStartCarriesTheFamilyBooleanTheProfileAndTheWorkspaceNeverAnAccount() throws {
    let pi = profile("pi-fast", "Pi fast", .pi, builtIn: true, source: "base", pi: PiProfileSettings(provider: "openai", model: "m", thinking: .low))
    let input = startInput(profile: pi, workspace: workspace)
    XCTAssertEqual(input.cwd, "/Users/v/project")
    XCTAssertEqual(input.options?.piMode, true)
    XCTAssertNil(input.options?.claudeMode)
    XCTAssertNil(input.options?.codexMode)
    XCTAssertNil(input.options?.antigravityMode)
    XCTAssertEqual(input.options?.launchProfileId, "pi-fast")
    XCTAssertEqual(input.options?.launchProfile, LaunchProfileView(id: "pi-fast", name: "Pi fast", family: .pi, command: ["pi"], additionalArgs: ["--flag"], sourceProfileId: "base", pi: PiProfileSettings(provider: "openai", model: "m", thinking: .low)))
    XCTAssertEqual(input.options?.workspaceId, "w-1")
    let body = try ContractJSON.encodeToString(input)
    XCTAssertFalse(body.lowercased().contains("account"))
    XCTAssertFalse(body.contains("builtIn"))
    XCTAssertEqual(startInput(profile: pi, workspace: workspace, cwd: "/Users/v/project/sub").cwd, "/Users/v/project/sub")
    for (family, check) in [(LauncherFamily.claude, \SpawnOptions.claudeMode), (.codex, \.codexMode), (.antigravity, \.antigravityMode)] {
      XCTAssertEqual(startInput(profile: profile("x", "X", family), workspace: workspace).options?[keyPath: check], true)
    }
  }
}
