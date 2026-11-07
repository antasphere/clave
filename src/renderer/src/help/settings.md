# Settings

Configure your Clave experience. Open with **Cmd+,** or from the sidebar.

[Open Settings](clave://navigate/settings)

## Profile

Set your display name, choose an avatar icon, and pick an avatar color. Your profile appears in session headers.

## Appearance

Choose between three themes:

- **Dark**: Default dark theme
- **Light**: Light theme
- **Coffee**: Warm-toned dark theme

## Agents

Create named launch profiles for Claude, Antigravity, Codex, and Pi. Commands and additional arguments are token arrays, so wrappers work without shell parsing. Set a global default and an optional default for each workspace. Pi profiles can also select a provider, model, and thinking level.

For `tokenops run -- env -u ANTHROPIC_API_KEY claude`, enter each word as one Command token, in that order. Clave appends its session, model, integration, and prompt arguments after the profile tokens.

Launch profile arguments are stored locally without encryption. Do not put secrets in them.

## Workspaces

Manage multiple workspaces. Each workspace has its own sessions, groups, and settings.

## Locations

Configure remote SSH locations for running sessions on other machines. See the **Remote Sessions** doc for details.

## Debug the running app

Choose **Help > Debug Clave…**, or open Help in the side panel and choose
**Debug Clave…**. Clave captures the current app instance before adding a support
tab. The dialog shows the capture time, instance, windows, session count, and
any missing sources. Preview or copy the context before starting a conversation.

Choose Claude Code or Codex, an offered launch profile, and an existing account.
The support tab uses those choices and the profile's permissions. This action
does not change your defaults or stop your other sessions. Describe the problem
to include it in the support prompt. The playbook tells the agent to ask before
fixes or restarts. It does not restrict an unrestricted launch profile.

If login or startup fails, check the new tab and use **Copy context** or
**Copy support prompt**. An unconfirmed launch is not retried automatically.
Closing and reopening the dialog keeps the capture and any known support tab.
Choose **Check support tab** to reconcile an unconfirmed launch. If a known
support tab was closed, Clave allows a fresh capture. An unknown delayed launch
stays blocked to avoid creating a duplicate. Capturing again keeps your choices.
For an attached server, in-app launch is unavailable because the server may
use another filesystem. Copy the context, or run the displayed external command
on the same Mac that created the capture, using that Mac's CLI settings and login.
