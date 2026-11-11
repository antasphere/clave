import Foundation

// Which saved launch profiles a phone offers and what a start carries,
// ported from the prototype's `orderProfiles`, `startPayload` and
// `familyBoolean` (`apps/mobile/src/state/store.ts`) and the chat test of
// `screens/LaunchScreen.tsx` (`docs/mobile.md`, "Launch"): the profiles of
// the person's main machine, chat profiles first; the terminal built-ins of
// the Mac's own constant are not offered, since the phone shows no
// terminal. A start carries the family boolean, `launchProfileId`, the
// profile's full definition and the workspace, never an account.

/// The ids of the Mac's built-in terminal profiles (`BUILT_IN_LAUNCH_PROFILES` in `packages/shared/src/agent-launch.ts`).
public let builtInTerminalProfileIds: Set<String> = ["builtin-claude", "builtin-antigravity", "builtin-codex", "builtin-pi"]

/// Whether a profile opens a chat (the events transport) rather than a terminal.
public func isChatProfile(_ profile: LaunchProfileView) -> Bool {
  profile.id == "claude-chat" || profile.id == "codex-chat" || profile.id.hasPrefix("chat:") || profile.id == "dev-echo-adapter"
}

/// The profiles the launch screen offers, chat profiles first, then the rest, each group by name.
public func launchChoices(_ preferences: LaunchProfilePreferencesView) -> [LaunchProfileView] {
  orderProfiles(preferences.customProfiles.filter { !builtInTerminalProfileIds.contains($0.id) })
}

/// Chats first, then the rest, each group by name: the launch form's order.
public func orderProfiles(_ profiles: [LaunchProfileView]) -> [LaunchProfileView] {
  profiles.sorted { a, b in
    let chatA = isChatProfile(a)
    let chatB = isChatProfile(b)
    if chatA != chatB { return chatA }
    return a.name.localizedCompare(b.name) == .orderedAscending
  }
}

/// The spawn options of a profile's family: exactly one boolean set.
public func familyOptions(_ profile: LaunchProfileView) -> SpawnOptions {
  switch profile.family {
  case .claude: return SpawnOptions(claudeMode: true)
  case .codex: return SpawnOptions(codexMode: true)
  case .pi: return SpawnOptions(piMode: true)
  case .antigravity: return SpawnOptions(antigravityMode: true)
  }
}

/// The start a phone sends: in the workspace's root unless `cwd` says otherwise, the family boolean,
/// the profile by id and its full definition (the seam the Mac uses for a server), the workspace.
/// The target's accounts stay its own: none is carried.
public func startInput(profile: LaunchProfileView, workspace: WorkspaceView, cwd: String? = nil) -> StartSessionInput {
  var options = familyOptions(profile)
  options.launchProfileId = profile.id
  options.launchProfile = LaunchProfileView(
    id: profile.id,
    name: profile.name,
    family: profile.family,
    command: profile.command,
    additionalArgs: profile.additionalArgs,
    sourceProfileId: profile.sourceProfileId,
    pi: profile.pi)
  options.workspaceId = workspace.id
  return StartSessionInput(cwd: cwd ?? workspace.rootDir, options: options)
}
