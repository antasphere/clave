/**
 * When the agent updater runs on its own, and the two test seams, as pure
 * rules so each is tested rather than read off `index.ts`.
 */
export interface ScheduleInputs {
  testMode: boolean
  packaged: boolean
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

export interface AgentUpdateSchedule {
  /** The installers' commands are POSIX only for now: never on Windows. */
  supported: boolean
  /**
   * The timers run in the shipped app only. A dev build shares the machine's
   * CLIs with the installed Clave, and two apps upgrading the same prefix on
   * their own clocks is a race nobody asked for; the buttons still work.
   * `CLAVE_AGENT_UPDATES_AUTO=1` runs them from a dev build. Never in test mode.
   */
  scheduled: boolean
  /** E2E seams, honoured in test mode only (`--test-no-activate`): the PATH
   *  the updater searches and the registry it asks, so a spec drives fixture
   *  CLIs and never the machine's own agents. */
  agentPath: string | undefined
  registry: string | undefined
}

export function agentUpdateSchedule(inputs: ScheduleInputs): AgentUpdateSchedule {
  const supported = inputs.platform !== 'win32'
  return {
    supported,
    scheduled:
      supported &&
      !inputs.testMode &&
      (inputs.packaged || inputs.env.CLAVE_AGENT_UPDATES_AUTO === '1'),
    agentPath: inputs.testMode ? inputs.env.CLAVE_TEST_AGENT_PATH : undefined,
    registry: inputs.testMode ? inputs.env.CLAVE_TEST_NPM_REGISTRY : undefined
  }
}
