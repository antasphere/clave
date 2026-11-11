import ClaveCore
import Foundation
import Observation

/// The Launch screen's state: the saved profiles of the source machine (the person's main machine
/// when it is reached, else the target), and a start on the target machine in the workspace.
@Observable @MainActor final class LaunchModel {
  let target: MachineConnection
  let source: MachineConnection
  let workspace: WorkspaceView

  private(set) var profiles: [LaunchProfileView] = []
  private(set) var loading = false
  private(set) var loaded = false
  private(set) var loadError: String?
  /// The id of the profile being started.
  private(set) var starting: String?
  /// The server's sentence for the last start it refused.
  private(set) var refusal: String?

  init(target: MachineConnection, source: MachineConnection, workspace: WorkspaceView) {
    self.target = target
    self.source = source
    self.workspace = workspace
  }

  /// Whether the profiles come from another machine than the one the session runs on.
  var sourceDiffers: Bool { source.machineId != target.machineId }

  func load() async {
    loading = true
    defer {
      loading = false
      loaded = true
    }
    do {
      profiles = launchChoices(try await source.client.launchProfiles.list())
      loadError = nil
    } catch let error as ServerError {
      loadError = error.message
    } catch {
      loadError = "The saved profiles could not be read."
    }
  }

  /// Starts a profile on the target; the list stays and the server's sentence is kept when it refuses.
  func start(_ profile: LaunchProfileView) async -> Session? {
    guard starting == nil else { return nil }
    starting = profile.id
    refusal = nil
    defer { starting = nil }
    do {
      return try await target.startSession(startInput(profile: profile, workspace: workspace))
    } catch let error as ServerError {
      refusal = error.message
    } catch {
      refusal = "The session could not start."
    }
    return nil
  }

  /// The navigation once a session started: the Launch route gives way to the conversation.
  nonisolated static func path(afterStarting sessionId: String, machineId: String, from path: [Route]) -> [Route] {
    var next = path
    if case .launch? = next.last { next.removeLast() }
    next.append(.chat(machineId: machineId, sessionId: sessionId))
    return next
  }
}
