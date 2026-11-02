/**
 * The launch decision, taken ONCE for the whole shell (ADR 0003): which
 * server this app runs on, read off the environment and the command line
 * with the two facts only main knows (whether the app is packaged, the
 * platform), and the two variables taken out of the environment before
 * anything in this process spawns (`takeServerLaunch`: the token belongs to
 * what is meant to call the server, and no session, helper or nested Clave
 * may inherit it). Every module whose behaviour follows where the server
 * runs reads THIS value: main's boot (`index.ts`, which starts or attaches
 * to that server and marks it external), and the shell's settings source
 * (`settings/shell-source.ts`), which builds an Antasphere account manager
 * only when the server runs in this process.
 *
 * Until 2 November 2026 the settings source took a decision of its own from
 * the environment alone, so a separate server (the packaged default on
 * macOS, or `--server=separate`) left the shell with an account manager no
 * login ever reached, and the browser handoff the server had issued was
 * refused by that idle manager right at the open: the installed app never
 * opened the browser and the server waited five minutes for a callback
 * (clave-os, workstream 2026-11-02-antasphere-login-separate-server).
 *
 * Imported early, by whichever module needs it first; the decision is the
 * same for everyone after. A `--server` value that is not a mode ends the
 * launch here, with the sentence on stderr and exit code 2: a typo must not
 * pick a mode, and an error box the person cannot read past is no answer
 * either (the round-1 verifier of wave 5 watched the throw land in
 * Electron's dialog, the process alive until dismissed).
 */
import { app } from 'electron'
import { takeServerLaunch, type ServerLaunch } from './server-boot'

// The inputs are read before the try: the only thing the catch is for is a
// flag that is not a mode, and a read that throws (a test's Electron stand-in
// with no `app`) must fail as itself, never as a flag error with exit 2.
const input = { argv: process.argv, packaged: app.isPackaged, platform: process.platform }

export const serverLaunch: ServerLaunch = (() => {
  try {
    return takeServerLaunch(process.env, input)
  } catch (err) {
    process.stderr.write(`[server] ${(err as Error).message}\n`)
    return process.exit(2)
  }
})()
