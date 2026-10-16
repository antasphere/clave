# Standalone server on a Tailscale machine

A Clave daemon owns its sessions, sidebar and history. Desktop clients can attach and leave without stopping it. The machine must already have Node, Clave's installed dependencies, the built server and terminal-process bundles, and the coding tools/accounts you intend to use. Run it as the user who owns the repositories and credentials.

Build the checkout with `npm run build`. Start the same build on the server with an explicit data directory and the machine's own Tailscale IP or hostname:

```sh
install -d -m 700 "$HOME/.local/share/clave-server"
node out/main/server-entry.js \
  --daemon \
  --data-dir "$HOME/.local/share/clave-server" \
  --host 100.64.0.2 \
  --port 43127 \
  --terminal-process "$PWD/out/main/terminal-process.js" \
  --node "$(command -v node)"
```

Replace the address with this machine's address. Omitting `--host` binds loopback. Numeric aliases for wildcard listeners, including expanded IPv6 zero and IPv4-mapped zero, are refused. Hostnames resolve once with a five-second deadline; any wildcard DNS answer rejects startup, and the server binds and advertises the checked numeric address. Clave does not install, configure or expose Tailscale. Use a service manager to keep this command independent of the desktop and terminal that launches it. A minimal Linux user service can use the same absolute executable/bundle paths, `Restart=on-failure`, `KillMode=control-group` and `UMask=0077`. Configure the service account's PATH so its coding tools are available. Enable user lingering through your machine's normal administration if the user service must start before login. Service installation and network administration are separate operator actions.

`--daemon` forbids `--parent`. The existing app-owned child mode, without `--daemon`, retains its parent watchdog and launch handshake. A daemon reports its address and server ID on stdout, with no token. Diagnostics go to stderr. SIGTERM/SIGINT stop this server and its owned processes. Closing or intentionally disconnecting a client does neither.

## Credentials and recovery

The first daemon start creates `daemon/identity.json` under the data directory, containing a stable server UUID and a random bearer token. The directory is mode 0700 and the file mode 0600. Use its token to add the server on each trusted desktop device. Treat it like a password; do not put it in a command line, log, screenshot or version control. To provision an existing credential on the first start, use `--token-file /absolute/private/file`. That file must be mode 0600 and contain 32 to 4096 printable non-space characters. A later supplied token must match the saved credential; startup never silently replaces it.

Back up the entire private data directory. Keep the identity when restarting or upgrading so clients see the same server. `clave-server.json` is transient local discovery, includes the credential for privileged local consumers, and disappears on normal shutdown. `daemon/process.json` prevents two daemons from writing one directory. A crashed process's lease is reclaimed when its PID no longer exists. An exclusive `daemon/process.guard` serializes the complete lease acquisition and release transaction. If a process crashes during that brief transaction, startup fails closed: stop the service, confirm that no daemon using this directory remains, inspect the guard and lease, then remove the guard before restarting. Do not remove a guard while any starter is still running. An unrelated process reusing the lease PID requires the operator to inspect and remove the stale lease while the daemon is stopped.

On macOS settings secrets use Keychain. On Linux they use AES-256-GCM under `secrets/`, with a private 32-byte `master.key`. The key and encrypted values must be backed up together. This protects against other filesystem users; it does not protect against the owning user or root. Missing, insecure, corrupt or symlinked credential/key state fails closed. There is no plaintext settings fallback. Credential rotation is an operator action while stopped: replace only the token in the private identity file, retain its UUID and permissions, and update saved device credentials.

## Shared state and explicit Resume

All daemon sidebar calls resolve to the canonical layout key `server`, regardless of the client window key. The server owns group names, membership, tab creation/close and ordering. Revisions persist across restart and stale saves receive the current snapshot as a conflict. Collapse, selection, scrolling and pane geometry belong to the client. Moving a daemon tab between Electron windows is not a server capability.

The daemon uses its own PTYs rather than leaving tmux shells behind it. After daemon restart, prior records are visible with state `ended`. Reading history, subscribing to a stopped tab or resizing it starts nothing. The desktop's explicit Resume uses `sessions.restart(id, account, false)` and retains the server-local tab ID, provider settings and conversation identifier. A terminal resumes as a new shell; it does not rerun the interrupted command. Automatic record adoption through `sessions.start` is refused for a stopped saved ID. Live daemon sessions cannot be detached through client window release.

The daemon records recent history even with no clients. A checkpoint retains at most 2000 typed events within 1 MiB and at most 128 KiB of recent terminal output. Provider transcripts remain the source of full conversation history. Raw provider frames are excluded. History files are private and written atomically. Closing a tab removes its record, recent history and shared sidebar placement. A client already viewing a stopped tab follows its stream when another client explicitly resumes it.

Desktop fleet routing, file transfer and pending agent requests are integrated by their separate delivery lanes. The daemon's backend API does not imply those desktop features are released.

## Repeatable backend check

After `npm run build`, run:

```sh
node_modules/.bin/bun scripts/check-server-daemon.mjs
node scripts/check-daemon-lease.mjs
```

This starts only isolated loopback daemons on OS-assigned ports, with data under `/tmp/clave-vps-b-impl/daemon-check-*`. It checks real terminal I/O, two API/push clients, unauthorized access, shared layouts, detach/catch-up, server restart, stable credentials, stopped restoration and explicit Resume without shell replay. It exits non-zero on failure and stops only the processes it launched. Its private data and `proof.json` remain for inspection. It does not configure a real Tailscale machine or replace the wave's two-Electron-client acceptance fixture.

The lease check holds one real starter at a stale-owner timing barrier, asserts that a concurrent starter is rejected, then kills only its own serving daemon and verifies recovery with the same identity. It retains private evidence under `/tmp/clave-vps-b-impl/lease-check-*`.
