import Foundation

// The settings domains a phone reads: the launch profiles of its main
// machine and the workspaces of a machine (`settings/launch-profiles.ts`,
// `settings/workspaces.ts`).

public enum LauncherFamily: String, Codable, Sendable, CaseIterable {
  case claude, antigravity, codex, pi
}

public enum PiThinkingLevel: String, Codable, Sendable, CaseIterable {
  case off, minimal, low, medium, high, xhigh, max
}

public struct PiProfileSettings: Codable, Sendable, Equatable, Hashable {
  public let provider: String?
  public let model: String?
  public let thinking: PiThinkingLevel?

  public init(provider: String? = nil, model: String? = nil, thinking: PiThinkingLevel? = nil) {
    self.provider = provider
    self.model = model
    self.thinking = thinking
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    provider = try c.decodeOptionalString("provider")
    model = try c.decodeOptionalString("model")
    thinking = try c.contains(AnyKey("thinking")) ? c.decodeLiteral("thinking", PiThinkingLevel.self) : nil
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encodeIfPresent(provider, key: "provider")
    try c.encodeIfPresent(model, key: "model")
    try c.encodeIfPresent(thinking, key: "thinking")
  }
}

/// A saved launch profile as the server lists it; a start carries the whole definition.
public struct LaunchProfileView: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let name: String
  public let family: LauncherFamily
  public let command: [String]
  public let additionalArgs: [String]
  public let builtIn: Bool?
  public let sourceProfileId: String?
  public let pi: PiProfileSettings?

  public init(id: String, name: String, family: LauncherFamily, command: [String], additionalArgs: [String], builtIn: Bool? = nil, sourceProfileId: String? = nil, pi: PiProfileSettings? = nil) {
    self.id = id
    self.name = name
    self.family = family
    self.command = command
    self.additionalArgs = additionalArgs
    self.builtIn = builtIn
    self.sourceProfileId = sourceProfileId
    self.pi = pi
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeString("id")
    name = try c.decodeString("name")
    family = try c.decodeLiteral("family", LauncherFamily.self)
    command = try c.decodeValue("command", [String].self)
    additionalArgs = try c.decodeValue("additionalArgs", [String].self)
    builtIn = try c.decodeIfPresent("builtIn", Bool.self)
    sourceProfileId = try c.decodeOptionalString("sourceProfileId")
    pi = try c.decodeIfPresent("pi", PiProfileSettings.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(name, key: "name")
    try c.encode(family, key: "family")
    try c.encode(command, key: "command")
    try c.encode(additionalArgs, key: "additionalArgs")
    try c.encodeIfPresent(builtIn, key: "builtIn")
    try c.encodeIfPresent(sourceProfileId, key: "sourceProfileId")
    try c.encodeIfPresent(pi, key: "pi")
  }
}

/// `GET /launch-profiles`: the custom profiles and the defaults per family.
public struct LaunchProfilePreferencesView: Codable, Sendable, Equatable {
  public let customProfiles: [LaunchProfileView]
  public let globalDefaults: [String: String]
  public let workspaceOverrides: [String: [String: String]]

  public init(customProfiles: [LaunchProfileView], globalDefaults: [String: String], workspaceOverrides: [String: [String: String]]) {
    self.customProfiles = customProfiles
    self.globalDefaults = globalDefaults
    self.workspaceOverrides = workspaceOverrides
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let version = try c.decodeDouble("version")
    guard version == 1 else {
      throw DecodingError.dataCorruptedError(forKey: AnyKey("version"), in: c, debugDescription: "1")
    }
    customProfiles = try c.decodeValue("customProfiles", [LaunchProfileView].self)
    globalDefaults = try c.decodeValue("globalDefaults", [String: String].self)
    workspaceOverrides = try c.decodeValue("workspaceOverrides", [String: [String: String]].self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(1, key: "version")
    try c.encode(customProfiles, key: "customProfiles")
    try c.encode(globalDefaults, key: "globalDefaults")
    try c.encode(workspaceOverrides, key: "workspaceOverrides")
  }
}

/// What the phone sends to start a session: the family boolean, the profile
/// by id and its full definition, the workspace the record is stamped with.
/// Never an account.
public struct SpawnOptions: Codable, Sendable, Equatable {
  public var claudeMode: Bool?
  public var antigravityMode: Bool?
  public var codexMode: Bool?
  public var piMode: Bool?
  public var launchProfileId: String?
  public var launchProfile: LaunchProfileView?
  public var workspaceId: String?

  public init(claudeMode: Bool? = nil, antigravityMode: Bool? = nil, codexMode: Bool? = nil, piMode: Bool? = nil, launchProfileId: String? = nil, launchProfile: LaunchProfileView? = nil, workspaceId: String? = nil) {
    self.claudeMode = claudeMode
    self.antigravityMode = antigravityMode
    self.codexMode = codexMode
    self.piMode = piMode
    self.launchProfileId = launchProfileId
    self.launchProfile = launchProfile
    self.workspaceId = workspaceId
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    claudeMode = try c.decodeIfPresent("claudeMode", Bool.self)
    antigravityMode = try c.decodeIfPresent("antigravityMode", Bool.self)
    codexMode = try c.decodeIfPresent("codexMode", Bool.self)
    piMode = try c.decodeIfPresent("piMode", Bool.self)
    launchProfileId = try c.decodeOptionalString("launchProfileId")
    launchProfile = try c.decodeIfPresent("launchProfile", LaunchProfileView.self)
    workspaceId = try c.decodeOptionalString("workspaceId")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encodeIfPresent(claudeMode, key: "claudeMode")
    try c.encodeIfPresent(antigravityMode, key: "antigravityMode")
    try c.encodeIfPresent(codexMode, key: "codexMode")
    try c.encodeIfPresent(piMode, key: "piMode")
    try c.encodeIfPresent(launchProfileId, key: "launchProfileId")
    try c.encodeIfPresent(launchProfile, key: "launchProfile")
    try c.encodeIfPresent(workspaceId, key: "workspaceId")
  }
}

/// `POST /sessions/start`'s body.
public struct StartSessionInput: Codable, Sendable, Equatable {
  public let cwd: String
  public let windowKey: String?
  public let options: SpawnOptions?

  public init(cwd: String, windowKey: String? = nil, options: SpawnOptions? = nil) {
    self.cwd = cwd
    self.windowKey = windowKey
    self.options = options
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    cwd = try c.decodeString("cwd")
    windowKey = try c.decodeOptionalString("windowKey")
    options = try c.decodeIfPresent("options", SpawnOptions.self)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(cwd, key: "cwd")
    try c.encodeIfPresent(windowKey, key: "windowKey")
    try c.encodeIfPresent(options, key: "options")
  }
}

public struct WorkspaceView: Codable, Sendable, Equatable, Hashable, Identifiable {
  public let id: String
  public let name: String
  public let rootDir: String
  public let profileFile: String?
  public let createdAt: Double

  public init(id: String, name: String, rootDir: String, profileFile: String? = nil, createdAt: Double) {
    self.id = id
    self.name = name
    self.rootDir = rootDir
    self.profileFile = profileFile
    self.createdAt = createdAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    id = try c.decodeString("id")
    name = try c.decodeString("name")
    rootDir = try c.decodeString("rootDir")
    profileFile = try c.decodeNullableString("profileFile")
    createdAt = try c.decodeDouble("createdAt")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(id, key: "id")
    try c.encode(name, key: "name")
    try c.encode(rootDir, key: "rootDir")
    try c.encodeNullable(profileFile, key: "profileFile")
    try c.encode(createdAt, key: "createdAt")
  }
}

/// `GET /workspaces`: the registered workspaces of a machine and the state around them.
public struct WorkspaceStateView: Codable, Sendable, Equatable {
  public let workspaces: [WorkspaceView]
  public let lastActiveWorkspaceId: String?
  public let activeWorkspaceId: String?
  public let pins: [JSONValue]
  public let pinsMigrated: Bool
  public let revision: Double
  public let instance: String

  public init(workspaces: [WorkspaceView], lastActiveWorkspaceId: String?, activeWorkspaceId: String?, pins: [JSONValue], pinsMigrated: Bool, revision: Double, instance: String) {
    self.workspaces = workspaces
    self.lastActiveWorkspaceId = lastActiveWorkspaceId
    self.activeWorkspaceId = activeWorkspaceId
    self.pins = pins
    self.pinsMigrated = pinsMigrated
    self.revision = revision
    self.instance = instance
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: AnyKey.self)
    let version = try c.decodeDouble("version")
    guard version == 1 else {
      throw DecodingError.dataCorruptedError(forKey: AnyKey("version"), in: c, debugDescription: "1")
    }
    workspaces = try c.decodeValue("workspaces", [WorkspaceView].self)
    lastActiveWorkspaceId = try c.decodeNullableString("lastActiveWorkspaceId")
    activeWorkspaceId = try c.decodeNullableString("activeWorkspaceId")
    pins = try c.decodeValue("pins", [JSONValue].self)
    pinsMigrated = try c.decodeBool("pinsMigrated")
    revision = try c.decodeDouble("revision")
    instance = try c.decodeString("instance")
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: AnyKey.self)
    try c.encode(1, key: "version")
    try c.encode(workspaces, key: "workspaces")
    try c.encodeNullable(lastActiveWorkspaceId, key: "lastActiveWorkspaceId")
    try c.encodeNullable(activeWorkspaceId, key: "activeWorkspaceId")
    try c.encode(pins, key: "pins")
    try c.encode(pinsMigrated, key: "pinsMigrated")
    try c.encode(revision, key: "revision")
    try c.encode(instance, key: "instance")
  }
}
