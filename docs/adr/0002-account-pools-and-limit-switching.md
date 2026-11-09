# ADR 0002: account pools and limit-driven switching

Status: accepted, 2026-09-25 (implemented in the same change); amended 2026-09-26 (a tab the limit ended is brought back); amended 2026-11-09 (a quota is per account and model family); amended 2026-11-09 (a family's cap offers a model before an account)

## Context

A user works on several subscriptions at once: a personal plan, a company plan, and seats on teams that pay for their own. Today a Claude session can run on one of several accounts, chosen by hand at launch, and a Codex session always runs on whatever `~/.codex/auth.json` holds. When a subscription nears its cap the only way out is to pick another agent profile by hand and start over.

The current Claude account model (`src/main/claude-accounts.ts`) has three shapes: a pasted `claude setup-token` token held encrypted by `safeStorage`, a `CLAUDE_CONFIG_DIR` of its own, and the machine login. Codex has no account model at all; the usage read opens a short-lived `codex app-server` and asks it which account it is signed into.

## Decision

Clave keeps a pool of accounts per provider and can move work from one subscription to another when the first one is about to run out. Claude and Codex are supported first.

### Two managers, one policy

Each provider keeps its own account manager. The Claude manager already exists; a Codex manager is added beside it. A single switching policy sits above both and speaks in terms of an account's headroom, never in provider terms. The Claude manager's trust boundary and its tests are not touched by the Codex work.

### Claude accounts: one home, token credentials only

Every Claude account shares the machine's `~/.claude`. An account is a label plus a long-lived `claude setup-token` token, injected into the session as `CLAUDE_CODE_OAUTH_TOKEN`. History, plugins and settings stay shared, so a session can be resumed on any account. The config-dir shape is retired: existing config-dir accounts are migrated to token accounts on first launch after the change, and the user is asked to sign in again for each. The machine login remains the built-in Default account.

The token is stored as today, encrypted by the OS through `safeStorage`, and never leaves the main process. Clave records the capture date and assumes a one-year lifetime. The Accounts page shows the remaining lifetime. The first 401 on a read or a spawn marks the account dead and takes it out of the pool.

### Codex accounts: one home per account, everything symlinked but the credential

The Default Codex account is `~/.codex` as the user left it. Every other Codex account gets a directory of its own under Clave's user data, used as `CODEX_HOME` for the sessions that run on it. That directory holds a real `auth.json` and a symlink for every other top-level entry of `~/.codex`, so config, sessions, memories, skills and hooks stay shared and `codex resume` works across accounts.

The credential file is the source of truth. Codex refreshes it in place, so Clave keeps no encrypted copy; the file is protected by directory permissions, as Codex itself protects the default one. Codex rewrites some files by writing a temporary file and renaming it, which turns a symlink into a detached copy. Clave re-syncs the per-account home at every spawn: a missing link is added, a detached file is left as it is until the next spawn re-links it, and the edit made through the detached copy is lost. This is accepted.

### Logging in

The new Settings → Accounts page carries one "Log in" button per provider. Clave runs the provider's own login command in a hidden PTY owned by the main process, opens the browser link the command prints, captures the credential, and never renders it:

- Claude runs `claude setup-token` and captures the printed token by its `sk-ant-` shape. Pasting a token stays available as an alternative.
- Codex runs `codex login` with `CODEX_HOME` set to the new account's directory, so the credential lands in that account's `auth.json` and nowhere else.
- A Codex API-key account takes the key from an input and runs `codex login --with-api-key` against its own home. Such an account has no quota to read, so it never counts as "about to hit"; it is a fallback that the pool only reaches when every subscription account is exhausted.

The user can add as many accounts as they hold.

### What "about to hit the limit" means

A quota is per account AND model family. Anthropic meters a subscription with shared caps (the weekly all-models cap, and the 5-hour block where the plan still has one) and one weekly cap per family (Fable, Opus, Sonnet), reported as `weekly_scoped` windows whose scope is the family. A family cap that is out stops the sessions on that family and nothing else, so an account is never "at limit" because one family's week is spent.

An **account** is exhausted when its tightest SHARED cap has about five percent or less left, or the service already calls it critical. A family whose cap is out is a fact of its own on the account's summary (`scopedOut: ['Fable']`), shown beside the shared headroom and never as the account's exhaustion. A **session** is exhausted when a shared cap or its OWN family's cap is: its usage is read through the session's model (`usageSummaryForModel`, `claudeUsageForModel`), which keeps the shared caps and that family's cap and drops the other families'. A **launch** picks its account for the model it will run (`accountForLaunch(provider, preferredId, model)`): an account with its Fable week spent and 60% of its week left takes a launch on Opus and refuses one on Fable. A launch with no model is judged on the shared caps alone. The threshold is the same for both providers. A family is any window the service scopes to a model, whatever its kind: Codex's Spark bucket carries a 5-hour block and a weekly cap of its own, both scoped `Spark`, and is a family the same way, so a Codex session on a Spark model is judged on the shared caps and the Spark ones, and a session on another model on the shared caps alone. Claude reads the unified rate-limit headers or the usage endpoint as today; Codex reads `account/rateLimits/read`.

The 5-hour block is optional: Anthropic removed it for verified Ultra accounts on 2026-10-30 (Pro and Max keep it). Nothing assumes a `session` window exists. Automatic switches rank their targets by weekly headroom (the least left among the view's weekly caps, the all-models cap or the session's family), the 5-hour block breaking a tie only when every target has one.

A cap that is out is named one way everywhere, `<Cap> out · back <when>` (`Fable out · back in 2d 5h`, `Overall out · back Thu 14:00`): the cap by its short name, the return by the service's reset. The words "At limit", "Limit reached" and "out of usage credits" are retired; an account-level readout gives the shared headroom first, then every family that is out; a session-level readout names the cap that stops that session.

Until 2026-11-09 the summary took the tightest window over every cap with no model context, so the moment the Fable weekly cap was critical the account read "at limit" in every account-level readout and a new launch on Opus skipped it with most of the week left. Only a session whose model was known filtered correctly (PR #208).

### When a switch happens

A running session is never interrupted by the poll. The five-minute usage poll does two things only: it rotates the account that the next spawn on that provider will use, and it raises a badge on sessions whose account is exhausted.

A session moves to another account only when its own CLI reports the limit, or when the user asks. The move is a restart of the CLI on the new account with the provider's resume (`claude --resume` or `codex resume`), so the transcript comes along and no handoff summary is needed.

### Order and configuration

The pool rotates round robin: the accounts of the provider in the order the user set on the Accounts page, starting after the one just left, skipping any that is exhausted, expired, dead, or pinned out. When every account is exhausted the next spawn takes the one that resets soonest. The list is reorderable.

Two knobs are configurable at the workspace level with a per-session override:

- **Mode**: `propose` (default) shows the switch and waits for the user; `automatic` performs it.
- **Pin**: off by default; a pinned session never leaves its account.

### Records, `.clave` files and agents

The session record keeps the account id and label so that a restore after a crash reopens the session on the account it last ran on. A switch rewrites the record.

The `.clave` schema gains an account field that names an account by label, or `any` for the pool. Labels are per machine and ids are not, and `.clave` files are committed and shared. An unknown label falls back to the Default account with a visible note. The field does not drive an agent, so it is not elevated; it still moves through all six mirrors of the schema and both round-trip normalisations, as the schema sync rule requires.

`clave_open_session` takes the same label or `any`. An agent may ask to move its own session to another account through the MCP tools; the request goes through the same mode setting as a user-initiated switch.

### What shipped

Everything above, in one change: the Accounts page with both login flows, the migration of config-dir accounts, the Codex per-account home, the exhaustion badge, the manual switch with resume (the tab's menu, `clave_switch_account`), the pool for new spawns, the `propose` and `automatic` modes (global, per workspace, per session), pins, the chat CLI's own limit reports as a trigger, and the `.clave` `account` field through all six mirrors.

**Amendment, 2026-09-26 — the limit that ends the process.** "A session moves when its own CLI reports the limit" assumed the CLI stays up to be moved. Claude Code in `-p` mode does not: some limits (out of usage credits, the org's cap, the plan's usage limit) never come as a `rate_limit_event`; the CLI writes a synthetic reply in the model's place ("You're out of usage credits…", `message.model` = `<synthetic>`) and ends its process right after, and the policy, which only ever moved a live tab, left it on "Session ended (exit 143)" with the composer closed. Three things change. That synthetic reply counts as the CLI's report (`providerEventReportsLimit`). A tab that ended on the CLI's own report — never on the poll's reading alone — is restarted on the next account the same way a live one is moved, at once in automatic mode, on one click in the pane in propose mode, and the message the limit rejected is sent again on the new account, so the reader gets the answer they asked for; a move made by hand or by an agent never resends. And the pane's ended notice names the account that is out and the way on, instead of the exit code. Two consequences the fix surfaced: the renderer's `ended` word for a session is now confirmed against the session record before the tab is marked dead, because the state channel and a restart's reply are not ordered against each other and the old process's last word was landing on the new one; and the resend rides the restart as a main-only spawn field (`initialInput`) that a renderer's spawn never carries.

**Amendment, 2026-11-09 (PRDCT-4302) — a family's cap offers a model before an account.** The decision above knew one lever, the account, and read the CLI's report as a bare yes; with the quota per family, the right move when a Fable week is spent is usually to continue on Opus 5.5 on the same subscription, which still has its week, and the CLI's own words at that moment are "Switch to another model". Four things change.

_The report carries its scope._ `limitReportOf(provider, payload)` (`src/main/sessions/limit-report.ts`) reads the CLI's frame into `{ scope, resetsAt? }`, the scope one of `shared` (the 5-hour block, the week: `five_hour`, `seven_day`, `seven_day_overage_included`), `{ family }` (`seven_day_opus`, `seven_day_sonnet`, the service's `oi` code for Fable, or the text "Fable limit reached" in a synthetic reply), `credits` (the synthetic "out of usage credits" reply: the org's or the seat's, the account as a whole) or `unknown`. The report rides `session.limit_reported` on both transports, the way the model change does, and `session.limitReported` in the window is the report, not a flag. The CLI's enum has no Fable value and types a Fable rejection as a plain week, so the window resolves a `shared` or `unknown` report against the forced read of the session's own view (`resolveLimitScope`): the session's family cap out while the shared caps are open is that family's cap, whatever the CLI typed; a shared cap out is the account's; no evidence in the read falls to the account rung, as before.

_Three rungs, in order._ `decideAccountAction` returns one proposal carrying the rungs that are open, the first the one automatic mode takes. A FAMILY's cap offers the **model rung** first: the newest model of the next family down on the same account whose cap the account's read shows open (`modelRungFor`: Fable → Opus 5.5, Opus → Sonnet 5.5, Sonnet → Haiku; the descent never steps up to a scarcer model), set on the live session with `set_model`, no restart; a dead process takes no model, so the rung needs a live tab. A SHARED cap or the CREDITS offer the **account rung** as before. The **provider rung** (continue on another agent CLI) comes third, only when another module registered the road (`registerProviderSwitchRoad`, lane D's provider switch), and is only ever offered, never taken on its own: a provider switch reconstructs the conversation. Automatic mode on a family's cap follows a workspace setting, `onFamilyLimit: 'switch-model' | 'switch-account'` (default `switch-model`, a global default with a per-workspace override like the mode), and falls to the other rung when the preferred one is not there. A session may be pinned to its model (`modelPinned`, session-lifetime like the account pin, from the tab's menu): the model rung is then never offered and the tab falls to the account rung; the account pin drops the account rung the same way, and both pins together mean no move, as the account pin alone did.

_The message the cap rejected goes again on the new model._ Main keeps every report open on the session with the message it rejected, whatever cap the CLI typed: its enum has no Fable value and types a Fable rejection as a plain week, so the WINDOW decides the rung from its read and main cannot know which one it took. The next model the provider confirms on that session's stream resends that one message, once, provided it is still the person's last, by whichever hand the model changed (the policy's rung, the person from the chip); the account rung's restart carries it instead (`initialInput`) and closes the report, as does a new message of the person. A hand switch with no open report never resends: the decision above holds for the account rung and for every switch outside a limit. A family the report names outright (`seven_day_opus`) wins over the tab's own model: a Fable tab told its Opus week is out is offered Sonnet 5.5. The policy's own `set_model` carries `remember: false`, so the way on at a cap never becomes the next chat's default.

_The card and the notices say the cap and offer the rungs._ The proposal badge and the ended notice of both chat views name the cap in the first wave's words (`Fable out · back in 2d 5h`), from the poll's read when it shows a cap out, else from the report's family and return, and offer the rungs as buttons in order: `Continue on Opus 5.5`, `Switch to <account>`, `Continue on Codex` when offered. In automatic mode the first rung says what is about to happen. The two launch roads the first wave left (the launcher's account button and the pinned road) judge their account for the model the launch will run, read off the chat-models preference main keeps for a fresh chat (`rememberedLaunchModel`); a terminal CLI's default this Mac cannot read, so such a launch is judged on the shared caps alone.

Two places where the implementation reads the decisions narrowly. A pin and a session's own mode are session-lifetime, not on the record: a restart of the app brings the tab back unpinned, on the workspace's mode. A Codex TERMINAL's thread is found in the store by cwd and start time, so two Codex terminals opened in the same folder within seconds of each other may resume each other's thread; a chat tab knows its thread from the app-server and never has that ambiguity.

## Consequences

Switching subscriptions no longer means choosing another agent profile: an agent profile describes how a CLI is launched, an account describes who pays, and they compose. The usage poll already reads every Claude account; it now reads every Codex account through its own home, one short-lived app-server per account. A Claude token account costs about twenty tokens per read.

Two subscriptions in flight at once is the normal case: one session may be on the company seat while another is on a personal plan. Each session's account is visible in its header and in `clave_list`.

Out of scope: Antigravity and Pi accounts, Claude API-key accounts, automatic switching triggered by scanning a PTY's output, and any handoff summary between accounts.
