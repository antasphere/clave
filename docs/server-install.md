# Running Clave on a server

A Clave server is the standalone daemon of [server-daemon.md](server-daemon.md). It runs on another machine, such as a Linux VPS, a home server or a Mac mini, and it owns its sessions, sidebar and history there. Your Mac connects to it, disconnects and reconnects without stopping anything. Agents run on the server, under the account of the user who installed it, with that user's repositories, `claude` / `codex` logins and git credentials.

`scripts/install-server.sh` installs that server as a service of the current user and updates it later. It runs on Linux with systemd and on macOS with launchd. Releases from 3.0.0-beta.6 onward have the server mode.

## Before you start

On the server, as the user who will run it (not root):

- **Node 22 or newer, git and a C toolchain**: on Debian or Ubuntu, `sudo apt install git build-essential python3` plus Node from [nodesource](https://github.com/nodesource/distributions) or nvm. On macOS, the Xcode command line tools.
- **The agents you want to run**, installed and logged in: `claude`, `codex`, `gh`, plus your repositories cloned.
- **A private way in from your Mac.** The server speaks plain HTTP with a bearer token, so never expose it on the public internet. Use one of these:
  - **Tailscale**: install it on both machines. The script listens on the server's Tailscale address when it finds one.
  - **SSH tunnel**: the server listens on loopback only, and your Mac reaches it through `ssh -N -L 43127:127.0.0.1:43127 you@server`.
- On Linux, **log in over SSH as that user** (not through `su` or `sudo -u`), so that the systemd user manager is there.

## Install

```sh
curl -fsSLo ~/install-server.sh https://raw.githubusercontent.com/antasphere/clave/dev/scripts/install-server.sh
bash ~/install-server.sh
```

The script:

1. picks the newest Clave release (pre-releases included), clones it under `~/.local/lib/clave-server/releases/<commit>` and builds it there (`npm ci`, `npm run build`; a few minutes, and about 1.5 GB per release);
2. writes the service: `~/.config/systemd/user/clave-server.service` on Linux (with lingering turned on, so it keeps running after you log out), or `~/Library/LaunchAgents/com.antasphere.clave-server.plist` on macOS;
3. starts it, checks that it answers, and prints its address and the command that shows its token.

Its options (`bash ~/install-server.sh --help` lists them). They are saved once a run with them has the server answering, and every later run reuses them:

| Option         | Default                                   | Meaning                                                                                                                                |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--ref`        | `latest`                                  | `latest` (newest release, pre-releases included), `stable`, or a tag or branch such as `v3.0.0-beta.6`                                 |
| `--host`       | `auto`                                    | `auto` uses the Tailscale address when Tailscale is up, else `127.0.0.1`. Also `tailscale`, `loopback`, or an address. Never `0.0.0.0` |
| `--port`       | `43127`                                   | Port to listen on                                                                                                                      |
| `--data-dir`   | `~/.local/share/clave-server`             | The server's private data: identity, token, history, encrypted settings                                                                |
| `--path`       | the PATH of the shell running the script  | The PATH the agents get, after Node's own directory, so run the first install from a login shell that finds `claude` and `codex`       |
| `--token-file` | none                                      | Provision the token from a 0600 file instead of generating one                                                                         |
| `--name`       | `clave-server`                            | Service name, for several servers on one machine                                                                                       |
| `--repo`       | `https://github.com/antasphere/clave.git` | Where to clone from, for a fork                                                                                                        |
| `--force`      |                                           | Rebuild and restart even when nothing changed                                                                                          |
| `--no-service` |                                           | Build only, and print the command to run under your own supervisor                                                                     |

The agents get that PATH through a login shell, which reads `~/.profile` (or `~/.zprofile`) and never `~/.bashrc`, so a `claude` or `codex` added to PATH only in `~/.bashrc` is not found and its sessions end with "command not found". Every run checks this and names the agent it cannot find, with the `--path` to run again with.

`auto` is decided once and saved as what it found (`tailscale` or `loopback`). A later run on a machine whose Tailscale is down then fails, rather than moving the server to loopback without telling you.

## Connect your Mac

1. On the server, print the token: `node -p 'require(process.env.HOME + "/.local/share/clave-server/daemon/identity.json").token'`. Treat it like a password: paste it into Clave and nowhere else (not a chat, a ticket or a commit).
2. In Clave on your Mac, open Settings → **Servers** (the Clave group of the settings sidebar) and add the server: a name, the address the script printed (for example `http://100.101.102.103:43127`, or `http://127.0.0.1:43127` through the SSH tunnel), and the token.
3. When you open a session, choose that server. The folder picker then browses the server's disk, and the server's sessions show its name in the sidebar.

The Servers page shows each server's version next to its state. When the app updates, its servers follow it: see below.

## Update

### From your Mac

When the app on your Mac updates (Settings → Software Update), every connected server installed by this script from a release tag upgrades itself to the same version, with no click:

- the Mac sees that the server's version is older than its own and asks it to upgrade to exactly its version. The server then waits until none of its agents has worked for a minute, and runs this script again with `--ref v<version>`, so it builds beside the running release, restarts on the new one and goes back to the previous one when that does not answer, as described below;
- Settings → Servers says where each server stands: "Upgrading to 3.0.0-beta.8 once no agent is working", "Upgrading to 3.0.0-beta.8…", or "Upgrade to 3.0.0-beta.8 failed:" with the script's own last three messages, credentials masked, then its exit code and where the full log is, when the build failed or the new release did not answer. Those messages are only the ones the script writes itself (its `[clave-server]` lines), which it also appends to a file of their own, `<data-dir>/upgrade/install-status`, named by `CLAVE_INSTALL_STATUS_FILE` and never passed to the commands it runs: nothing git, npm or the build prints, which can carry credentials, ever reaches the Mac. The server keeps running in that case, and the Mac does not try that version again on its own;
- **Upgrade now** starts the upgrade without waiting for idle, after warning that the running sessions end (they come back as ended tabs to Resume). It is also the way to try again after a failure;
- the run's output goes to `<data-dir>/upgrade/upgrade.log` on the server (`~/.local/share/clave-server/upgrade/upgrade.log` by default), and the script is run from a copy beside it. On Linux the run is a transient unit of your systemd user manager (`systemd-run --user`), outside the server's own service, so stopping the service does not stop the upgrade; on macOS it runs in a process group of its own;
- the saved `--ref` becomes the version the Mac asked for, so a later plain run stays on it;
- a server is never downgraded: one newer than the app says "Newer than this app" and is left as it is. One installed from a branch or a custom ref (`--ref dev`) is left alone too ("Installed from dev; upgrade it on the server"). A development build of the app never asks a server to upgrade.

**Servers from before this** (3.0.0-beta.6 and 3.0.0-beta.7) cannot be asked. The Servers page shows "Older Clave server: run this on the server" with the command to run there once, for example `bash ~/install-server.sh --ref v3.0.0-beta.8`. From then on the server follows the app on its own. A server started some other way than by this script shows the same command, which installs it with the script so the Mac can keep it on its version. The first run of a newer script also rewrites the service once (it now passes the release's version and how it was installed), so that run restarts the server even when the release has not changed.

### By hand

Run the script again:

```sh
bash ~/install-server.sh
```

It reuses the saved options, and `--ref` and the others still change them. When the release has not moved and the service is unchanged, it leaves the running server alone. Otherwise it builds the new release beside the running one and then:

- **restarts the server**: running sessions end and come back as ended tabs, which you Resume from the Mac; a terminal comes back as a new shell. So update when no agent is in the middle of something;
- checks that the server answers, and when it does not within a minute **goes back to how it ran before**: the previous release, the previous service and the previous options. The run then exits non-zero and saves nothing, so the next plain run stays on what worked;
- keeps the new and the previous release in `~/.local/lib/clave-server`, and deletes the older ones.

The script does not update on a timer on its own, because every update restarts the server and ends the agents running on it. If you schedule it, pick an hour when nothing runs, and give the job a PATH where `node` is found. Releases that ship the script also have a copy at `~/.local/lib/clave-server/current/scripts/install-server.sh`.

## Operate

|        | Linux                                      | macOS                                                                                       |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Status | `systemctl --user status clave-server`     | `launchctl print gui/$(id -u)/com.antasphere.clave-server`                                  |
| Logs   | `journalctl --user -u clave-server -n 100` | `tail -n 100 ~/Library/Logs/clave-server.log`                                               |
| Stop   | `systemctl --user stop clave-server`       | `launchctl bootout gui/$(id -u)/com.antasphere.clave-server`                                |
| Start  | `systemctl --user start clave-server`      | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.antasphere.clave-server.plist` |

- **Back up the whole data directory**, identity and `secrets/` together: on Linux, settings secrets are encrypted with `secrets/master.key`, which has to travel with them. Keep the identity across upgrades and your Macs keep recognising the server.
- **Rotating the token**: stop the service, replace the token in `daemon/identity.json` (keep its `serverId` and its 0600 mode), start it, and update the token in each Mac's Servers panel.
- **A headless Mac** runs the launchd agent only while its user is logged in, so turn on automatic login.
- **Uninstall**: stop and disable the service, then delete its unit or plist, `~/.local/lib/clave-server` and `~/.config/clave-server`. Delete the data directory only if you do not need its history.

How the daemon owns its sessions, recovers from crashes and shares requests across Macs is in [server-daemon.md](server-daemon.md) and [server-requests.md](server-requests.md).
