/**
 * The machines a phone may reach, behind one interface, whatever lists them:
 * the relay of the team (the real road, lane E's contract), or, in a
 * development build only, a server the developer pasted an address and a
 * token for. The shape is the wave's, written verbatim in the lane briefs
 * and reconciled by lane D on the integration branch.
 */
export type MachinePlatform = 'macos' | 'linux' | 'unknown'

export interface Machine {
  readonly id: string
  readonly name: string
  readonly platform: MachinePlatform
  readonly version: string
  readonly online: boolean
  /** Epoch milliseconds of the last time the relay heard the machine; null when never. */
  readonly lastSeen: number | null
  /** Where the machine's API is reached from the phone. */
  readonly baseUrl: string
  /** Where its push channel is reached. */
  readonly pushUrl: string
}

export interface MachineSource {
  list(): Promise<Machine[]>
}

/** What a machine is reached with: its API's base URL and the bearer the
 *  phone holds for it (a device session once lane A lands; a server token on
 *  a developer machine). Keyed by machine id in the secure store. */
export interface Credential {
  readonly serverUrl: string
  readonly bearer: string
}

export interface CredentialStore {
  get(machineId: string): Promise<Credential | null>
  set(machineId: string, credential: Credential): Promise<void>
  remove(machineId: string): Promise<void>
  /** The machine whose saved profiles the launch form lists (decision 7):
   *  the first paired, or the one marked main on the phone. */
  mainMachineId(): Promise<string | null>
  setMainMachineId(machineId: string | null): Promise<void>
}
