# ADR 0001: agent launch profiles and capabilities

Status: accepted, 2026-08-27

## Decision

Clave stores local agent launch profiles as argument arrays. A profile contains a wrapper command, extra arguments, and optional Pi provider settings. Clave appends the flags it owns, including session identity, resume identity, lifecycle integration, MCP configuration, and the initial prompt. The app quotes each token when adapting the array to its macOS login-shell process boundary. It does not parse shell syntax.

Built-in profiles are immutable. Custom profiles are local and editable. Resolution order is an explicit profile, the workspace override, the global default, then the built-in profile. `.clave` files contain only the agent mode, never a profile id or command.

Note, 3 November 2026: a saved profile has two forms, the terminal one and its chat form (`chat:<family>:<id>`, the "(chat)" entry the launcher offers beside it), one editable definition. An agent's `clave_open_session` with `chat: true` and no explicit profile resolves to the chat form of the profile this order yields for the family (`chatDefaultFor` in `src/shared/open-session-modes.ts`), so the chat an agent opens is the one the person gets from the launcher in that workspace; the built-in chat is the fallback for a default with no chat form. Until then the flag answered the built-in chat profile whatever the workspace was set to.

Arguments are not encrypted. The UI warns users not to store secrets in them. Wrappers should obtain credentials from the environment or a secret tool. Missing commands fail visibly and never fall back to a different binary.

## Pi capability record

Pi is a first-class local agent on macOS. Clave uses Pi's standard session store and a bundled extension for lifecycle state. The implementation follows Pi's official [extension documentation](https://pi.dev/docs/extensions), [session format](https://pi.dev/docs/sessions), and [press kit](https://pi.dev/press-kit).

The code capability table in `src/shared/agent-launch.ts` is the runtime source of truth.

| Capability                             | Pi status   | Reason                                                                                                              |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Launch, resume, history, search, usage | Supported   | Pi exposes stable CLI flags and JSONL sessions.                                                                     |
| Inbound `clave_send_to_session`        | Supported   | Clave can write to Pi's PTY.                                                                                        |
| In-agent Clave tools                   | Unsupported | Pi has no built-in MCP client. A future extension may provide an equivalent tool bridge.                            |
| Exchange capture                       | Unsupported | The current capture contract has no Pi identity or transcript adapter. Add a versioned contract before enabling it. |
| Blocked state                          | Unsupported | Pi does not expose a reliable permission-blocked lifecycle event.                                                   |

## Consequences

Launch configuration stays typed and testable, including wrapper commands such as `tokenops run -- env -u ANTHROPIC_API_KEY claude`. Shell pipelines and per-profile environment editing remain out of scope. Remote agents retain their current invocation path.
