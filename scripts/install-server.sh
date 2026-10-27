#!/usr/bin/env bash
# Installs or updates a standalone Clave server, the daemon of docs/server-daemon.md,
# as a service of the user running it: a systemd user unit on Linux, a launchd agent
# on macOS. Running it again updates: it builds the new release beside the running
# one, then stops the service, switches, starts it and checks it answers, and goes
# back to the previous release when it does not. See docs/server-install.md.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# A Mac that asked for this run (an upgrade from Settings → Servers) learns how
# it failed from the file CLAVE_INSTALL_STATUS_FILE names, and only from that
# file: `phase=<phase>` as each phase starts and `code=<code>` from `fail`,
# their values from the closed lists of packages/contract/src/upgrade-failure.ts.
# The server keeps nothing else from the file, so no text (a message, or what
# git or npm print, which can carry credentials) ever reaches a Mac. The path
# never reaches a command this script runs: STATUS_FILE keeps no export even
# when the environment had one, and the variable leaves the environment.
STATUS_FILE="${CLAVE_INSTALL_STATUS_FILE:-}"
export -n STATUS_FILE
unset CLAVE_INSTALL_STATUS_FILE
status_line() {
  [[ -n "$STATUS_FILE" ]] || return 0
  { printf '%s=%s\n' "$1" "$2" >> "$STATUS_FILE"; } 2>/dev/null || true
}
phase() { status_line phase "$1"; }

info()  { echo -e "${GREEN}[clave-server]${NC} $*"; }
warn()  { echo -e "${YELLOW}[clave-server]${NC} $*" >&2; }
# fail <code> <message>: the code for a Mac, the message for whoever reads the output.
fail()  { status_line code "$1"; shift; echo -e "${RED}[clave-server]${NC} $*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [options]

Installs a Clave server as a service of the current user, or updates it when it is
already installed. Options given on a first install are saved and reused by every
later run; an option given on a later run replaces the saved value.

Options:
  --ref REF          What to install: 'latest' (the newest release, pre-releases
                     included; the default), 'stable' (the newest stable release),
                     or a tag or branch name such as v3.0.0-beta.6 or dev
  --host HOST        Address to listen on: 'auto' (the default: this machine's
                     Tailscale IPv4 when Tailscale is up, else 127.0.0.1), 'tailscale',
                     'loopback', or an IP or hostname. Never a wildcard address.
  --port PORT        Port to listen on (default 43127)
  --data-dir DIR     The server's private data (default ~/.local/share/<name>)
  --token-file FILE  Provision the server's token from a private (0600) file on the
                     first start instead of generating one
  --path PATH        PATH the service runs its agents with (default: this shell's
                     PATH, saved on the first install)
  --name NAME        Service name, for several servers on one machine
                     (default clave-server)
  --repo URL         Git repository (default https://github.com/antasphere/clave.git)
  --force            Rebuild and restart even when the release is already current
  --no-service       Build and switch the release only; print the command to run
  --help             Show this help

Files:
  ~/.local/lib/<name>/          releases, 'current' and 'previous'
  ~/.config/<name>/install.env  the saved options
EOF
}

NAME=clave-server
OPT_REF='' OPT_HOST='' OPT_PORT='' OPT_DATA_DIR='' OPT_TOKEN_FILE='' OPT_PATH='' OPT_REPO=''
FORCE=0
SERVICE=1

need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail invalid-options "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)        need_value "$@"; OPT_REF="$2"; shift 2 ;;
    --host)       need_value "$@"; OPT_HOST="$2"; shift 2 ;;
    --port)       need_value "$@"; OPT_PORT="$2"; shift 2 ;;
    --data-dir)   need_value "$@"; OPT_DATA_DIR="$2"; shift 2 ;;
    --token-file) need_value "$@"; OPT_TOKEN_FILE="$2"; shift 2 ;;
    --path)       need_value "$@"; OPT_PATH="$2"; shift 2 ;;
    --name)       need_value "$@"; NAME="$2"; shift 2 ;;
    --repo)       need_value "$@"; OPT_REPO="$2"; shift 2 ;;
    --force)      FORCE=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    --help|-h)    usage; exit 0 ;;
    *)            usage >&2; fail invalid-options "Unknown option: $1" ;;
  esac
done

[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail invalid-options "--name must be lowercase letters, digits and dashes"
[[ $EUID -ne 0 ]] || fail run-as-root "Run this as the user who owns the repositories and agent logins, not as root"

case "$(uname)" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *)      fail unsupported-platform "Unsupported platform: $(uname)" ;;
esac

APP_DIR="$HOME/.local/lib/$NAME"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/$NAME"
CONFIG_FILE="$CONFIG_DIR/install.env"

# ── Saved options ──────────────────────────────────────────────────
CLAVE_REF=latest
CLAVE_HOST=auto
CLAVE_PORT=43127
CLAVE_DATA_DIR="$HOME/.local/share/$NAME"
CLAVE_TOKEN_FILE=''
CLAVE_PATH="$PATH"
CLAVE_REPO=https://github.com/antasphere/clave.git
CLAVE_URL=''   # where the release that last ran answered; not an option
FIRST_INSTALL=1
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
  FIRST_INSTALL=0
fi
[[ -n "$OPT_REF" ]] && CLAVE_REF="$OPT_REF"
[[ -n "$OPT_HOST" ]] && CLAVE_HOST="$OPT_HOST"
[[ -n "$OPT_PORT" ]] && CLAVE_PORT="$OPT_PORT"
[[ -n "$OPT_DATA_DIR" ]] && CLAVE_DATA_DIR="$OPT_DATA_DIR"
[[ -n "$OPT_TOKEN_FILE" ]] && CLAVE_TOKEN_FILE="$OPT_TOKEN_FILE"
[[ -n "$OPT_PATH" ]] && CLAVE_PATH="$OPT_PATH"
[[ -n "$OPT_REPO" ]] && CLAVE_REPO="$OPT_REPO"

[[ "$CLAVE_PORT" =~ ^[0-9]+$ && "$CLAVE_PORT" -ge 1 && "$CLAVE_PORT" -le 65535 ]] \
  || fail invalid-options "--port must be between 1 and 65535"
[[ "$CLAVE_DATA_DIR" = /* ]] || fail invalid-options "--data-dir must be an absolute path"
if [[ -n "$CLAVE_TOKEN_FILE" ]]; then
  [[ "$CLAVE_TOKEN_FILE" = /* ]] || fail invalid-options "--token-file must be an absolute path"
  [[ -f "$CLAVE_TOKEN_FILE" ]] || fail token-file-missing "No token file at $CLAVE_TOKEN_FILE"
fi

# ── Prerequisites ──────────────────────────────────────────────────
missing=()
for tool in git node npm cc make python3; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[[ ${#missing[@]} -eq 0 ]] || fail missing-tools "Missing: ${missing[*]}. Install Node 22 or newer, git and a C toolchain (build-essential and python3 on Debian or Ubuntu, the Xcode command line tools on macOS)."
# The real binary, not a version manager's shim: fnm points PATH at a per-shell
# link that is gone once that shell ends, and the service would lose its Node.
NODE="$(node -p 'process.execPath')"
node_major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 22 ]] || fail node-too-old "Node 22 or newer is required, found $("$NODE" --version)"
# Node's own directory first, so the agents installed with its npm (claude, codex)
# resolve for the service whatever the saved PATH holds.
SERVICE_PATH="$(dirname "$NODE"):$CLAVE_PATH"

# The agents start from the environment `$SHELL -lic` gives the service, which
# reads the login profile only: a PATH line in ~/.bashrc never reaches them, and
# the session ends with "claude: command not found". Ask that same shell, under
# the service's PATH and nothing else, which agent it cannot find.
warn_missing_agents() {
  local agent here
  for agent in claude codex; do
    env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" PATH="$SERVICE_PATH" \
      "${SHELL:-/bin/sh}" -lic "command -v $agent" </dev/null >/dev/null 2>&1 && continue
    here="$(command -v "$agent" 2>/dev/null || true)"
    if [[ -n "$here" ]]; then
      warn "$agent is not on the PATH the server's agents get, so its sessions end with \"command not found\". Run again with: --path \"$(dirname "$here"):$CLAVE_PATH\""
    else
      warn "$agent is not on the PATH the server's agents get, so its sessions end with \"command not found\". Install it, then run again with --path naming its folder"
    fi
  done
}

# ── Host ───────────────────────────────────────────────────────────
tailscale_ip() {
  command -v tailscale >/dev/null 2>&1 || return 1
  local ip
  ip="$(tailscale ip -4 2>/dev/null | head -n 1)" || return 1
  [[ -n "$ip" ]] || return 1
  echo "$ip"
}

# 'auto' is decided once and saved as what it found, so a later run on a machine
# whose Tailscale is down fails rather than moving the server to loopback.
if [[ "$CLAVE_HOST" == auto ]]; then
  if tailscale_ip >/dev/null; then CLAVE_HOST=tailscale; else CLAVE_HOST=loopback; fi
fi
case "$CLAVE_HOST" in
  tailscale) LISTEN_HOST="$(tailscale_ip)" || fail tailscale-down "Tailscale is not up on this machine (tailscale ip -4 gave nothing)" ;;
  loopback)  LISTEN_HOST=127.0.0.1 ;;
  *)         LISTEN_HOST="$CLAVE_HOST" ;;
esac
case "$LISTEN_HOST" in
  0.0.0.0|::|'[::]') fail wildcard-address "Refusing a wildcard address: the server speaks plain HTTP, reach it over Tailscale or an SSH tunnel" ;;
esac
if [[ "$LISTEN_HOST" == *:* ]]; then URL_HOST="[$LISTEN_HOST]"; else URL_HOST="$LISTEN_HOST"; fi
SERVER_URL="http://$URL_HOST:$CLAVE_PORT"

# ── Release resolution ─────────────────────────────────────────────
github_repo() {
  [[ "$CLAVE_REPO" =~ github\.com[:/]([^/]+)/([^/]+)$ ]] || return 1
  echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
}

# The newest release ('latest', pre-releases included, as GitHub lists them newest
# first) or the newest stable one ('stable'), by its tag.
release_tag() {
  local repo url
  repo="$(github_repo)" || fail invalid-options "--ref $1 needs a GitHub repository; give a tag or branch with --ref"
  if [[ "$1" == stable ]]; then
    url="https://api.github.com/repos/$repo/releases/latest"
  else
    url="https://api.github.com/repos/$repo/releases?per_page=1"
  fi
  # shellcheck disable=SC2016 # JavaScript, not shell
  "$NODE" -e '
    fetch(process.argv[1], { headers: { accept: "application/vnd.github+json", "user-agent": "clave-install-server" } })
      .then((r) => { if (!r.ok) throw new Error(`GitHub answered ${r.status}`); return r.json() })
      .then((j) => { const tag = Array.isArray(j) ? j[0]?.tag_name : j.tag_name; if (!tag) throw new Error("no release found"); console.log(tag) })
      .catch((e) => { console.error(e.message); process.exit(1) })
  ' "$url" || fail release-lookup-failed "Could not read the $1 release of $repo"
}

phase resolve
case "$CLAVE_REF" in
  latest|stable) REF="$(release_tag "$CLAVE_REF")" ;;
  *)             REF="$CLAVE_REF" ;;
esac

# A peeled tag first (the commit an annotated tag points at), then a tag, then a branch.
remote_refs="$(git ls-remote "$CLAVE_REPO" "refs/tags/$REF^{}" "refs/tags/$REF" "refs/heads/$REF")" \
  || fail repository-unreachable "Could not reach $CLAVE_REPO"
SHA=''
for wanted in "refs/tags/$REF^{}" "refs/tags/$REF" "refs/heads/$REF"; do
  SHA="$(awk -v ref="$wanted" '$2 == ref { print $1; exit }' <<<"$remote_refs")"
  [[ -n "$SHA" ]] && break
done
[[ -n "$SHA" ]] || fail no-such-release "No tag or branch named $REF in $CLAVE_REPO"

RELEASES="$APP_DIR/releases"
RELEASE="$RELEASES/$SHA"
CURRENT_LINK="$APP_DIR/current"
PREVIOUS_LINK="$APP_DIR/previous"
CURRENT=''
[[ -L "$CURRENT_LINK" ]] && CURRENT="$(readlink "$CURRENT_LINK")"

info "$REF is ${SHA:0:12}"

# ── Build ──────────────────────────────────────────────────────────
build_release() {
  local staging="$RELEASES/.building-$SHA"
  rm -rf "$staging"
  mkdir -p "$RELEASES"
  trap 'rm -rf "$staging"' EXIT
  phase clone
  info "Cloning $REF"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "$CLAVE_REPO" "$staging"
  local head
  head="$(git -C "$staging" rev-parse HEAD)"
  [[ "$head" == "$SHA" ]] || fail ref-moved "$REF moved while cloning (${head:0:12}, expected ${SHA:0:12}); run again"
  grep -q -- '--daemon' "$staging/src/main/server-entry.ts" \
    || fail release-too-old "$REF has no standalone server mode (it needs 3.0.0-beta.6 or newer)"
  phase dependencies
  info "Installing dependencies"
  # The server runs under Node: the Electron binary itself is never needed here.
  (cd "$staging" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund)
  phase build
  info "Building"
  (cd "$staging" && npm run build)
  [[ -f "$staging/out/main/server-entry.js" && -f "$staging/out/main/terminal-process.js" ]] \
    || fail build-incomplete "The build did not produce out/main/server-entry.js and out/main/terminal-process.js"
  echo "$REF" > "$staging/.clave-ref"
  rm -rf "$RELEASE"
  mv "$staging" "$RELEASE"
  trap - EXIT
}

if [[ "$CURRENT" == "$RELEASE" && -d "$RELEASE" && $FORCE -eq 0 ]]; then
  info "Already on $REF"
  UPDATED=0
else
  if [[ -d "$RELEASE" && $FORCE -eq 0 ]]; then
    info "Reusing the release already built for ${SHA:0:12}"
  else
    build_release
  fi
  UPDATED=1
fi

# The options are saved once the release they were given with runs, so a failed
# update leaves the next run on what worked.
save_options() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  {
    echo "# Written by install-server.sh; edit with its options rather than by hand."
    printf 'CLAVE_REF=%q\n' "$CLAVE_REF"
    printf 'CLAVE_HOST=%q\n' "$CLAVE_HOST"
    printf 'CLAVE_PORT=%q\n' "$CLAVE_PORT"
    printf 'CLAVE_DATA_DIR=%q\n' "$CLAVE_DATA_DIR"
    printf 'CLAVE_TOKEN_FILE=%q\n' "$CLAVE_TOKEN_FILE"
    printf 'CLAVE_PATH=%q\n' "$CLAVE_PATH"
    printf 'CLAVE_REPO=%q\n' "$CLAVE_REPO"
    printf 'CLAVE_URL=%q\n' "$SERVER_URL"
  } > "$CONFIG_FILE.tmp"
  chmod 600 "$CONFIG_FILE.tmp"
  mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

install -d -m 700 "$CLAVE_DATA_DIR"

# The service always starts from 'current', so a release switch is a link swap.
ARGS=(
  "$NODE" "$CURRENT_LINK/out/main/server-entry.js"
  --daemon
  --data-dir "$CLAVE_DATA_DIR"
  --host "$LISTEN_HOST"
  --port "$CLAVE_PORT"
  --terminal-process "$CURRENT_LINK/out/main/terminal-process.js"
  --node "$NODE"
)
[[ -n "$CLAVE_TOKEN_FILE" ]] && ARGS+=(--token-file "$CLAVE_TOKEN_FILE")
# The version the server reports, from the release tag: a beta's package.json
# carries the stable version it was cut from. A branch has no version of its own.
if [[ "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  ARGS+=(--app-version "${REF#v}")
fi
# How it was installed, so a Mac can ask it to upgrade itself to the Mac's
# version: it runs this script again with --name and --ref v<version> only.
# A release before that ignores flags it does not know.
ARGS+=(
  --install-name "$NAME"
  --install-script "$CURRENT_LINK/scripts/install-server.sh"
  --install-ref "$REF"
)

switch_to() {
  local target="$1"
  if [[ -n "$CURRENT" && "$CURRENT" != "$target" ]]; then
    ln -sfn "$CURRENT" "$PREVIOUS_LINK"
  fi
  ln -sfn "$target" "$CURRENT_LINK.tmp"
  mv -fT "$CURRENT_LINK.tmp" "$CURRENT_LINK" 2>/dev/null || mv -fh "$CURRENT_LINK.tmp" "$CURRENT_LINK"
}

# Keep 'current' and 'previous'; every other release goes.
prune_releases() {
  local keep_current keep_previous=''
  keep_current="$(readlink "$CURRENT_LINK")"
  [[ -L "$PREVIOUS_LINK" ]] && keep_previous="$(readlink "$PREVIOUS_LINK")"
  local dir
  for dir in "$RELEASES"/*; do
    [[ -d "$dir" ]] || continue
    [[ "$dir" == "$keep_current" || "$dir" == "$keep_previous" ]] && continue
    rm -rf "$dir"
  done
}

if [[ $SERVICE -eq 0 ]]; then
  switch_to "$RELEASE"
  prune_releases
  save_options
  info "Release $REF is in $CURRENT_LINK. Start the server with:"
  printf '  %q' "${ARGS[@]}"
  echo
  exit 0
fi

# ── Service ────────────────────────────────────────────────────────
LABEL="com.antasphere.$NAME"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NAME.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_FILE="$HOME/Library/Logs/$NAME.log"

systemd_quote() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "${s//%/%%}"; }
xml_escape() { local s="${1//&/&amp;}"; s="${s//</&lt;}"; printf '%s' "${s//>/&gt;}"; }

SERVICE_FILE="$UNIT_FILE"
[[ $PLATFORM == macos ]] && SERVICE_FILE="$PLIST"

render_service() {
  if [[ $PLATFORM == linux ]]; then
    local exec='' arg
    for arg in "${ARGS[@]}"; do exec+="$(systemd_quote "$arg") "; done
    cat <<EOF
# Written by install-server.sh; run it again rather than editing this file.
[Unit]
Description=Clave server ($NAME)
After=network-online.target tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=${exec% }
Environment=$(systemd_quote "PATH=$SERVICE_PATH")
WorkingDirectory=$HOME
Restart=on-failure
RestartSec=5
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
EOF
  else
    local args='' arg
    for arg in "${ARGS[@]}"; do args+="    <string>$(xml_escape "$arg")</string>"$'\n'; done
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by install-server.sh; run it again rather than editing this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$SERVICE_PATH")</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$HOME")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
  fi
}

write_service() {
  mkdir -p "$(dirname "$SERVICE_FILE")"
  printf '%s\n' "$SERVICE_TEXT" > "$SERVICE_FILE"
  if [[ $PLATFORM == linux ]]; then
    systemctl --user daemon-reload
    systemctl --user enable "$NAME.service" >/dev/null 2>&1 || fail service-enable-failed "systemctl --user enable $NAME failed"
  else
    mkdir -p "$(dirname "$LOG_FILE")"
    plutil -lint -s "$SERVICE_FILE" || fail invalid-service-file "Wrote an invalid $SERVICE_FILE"
  fi
}

stop_service() {
  if [[ $PLATFORM == linux ]]; then
    systemctl --user stop "$NAME.service" 2>/dev/null || true
  else
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # bootout returns before the job is gone, and a bootstrap meanwhile fails.
    local _
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0
      sleep 1
    done
  fi
}

service_active() {
  if [[ $PLATFORM == linux ]]; then
    systemctl --user is-active --quiet "$NAME.service"
  else
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q 'state = running'
  fi
}

start_service() {
  if [[ $PLATFORM == linux ]]; then
    systemctl --user start "$NAME.service"
  else
    launchctl bootstrap "gui/$(id -u)" "$SERVICE_FILE"
  fi
}

logs_hint() {
  if [[ $PLATFORM == linux ]]; then
    echo "journalctl --user -u $NAME -n 100"
  else
    echo "tail -n 100 $LOG_FILE"
  fi
}

# Answers once the server listens, within $1 seconds; the liveness route takes no token.
wait_healthy() {
  "$NODE" -e '
    const url = process.argv[1] + "/health/live"
    const deadline = Date.now() + Number(process.argv[2]) * 1000
    const once = () => fetch(url, { signal: AbortSignal.timeout(2000) })
      .then((r) => { if (r.ok) process.exit(0); throw new Error(String(r.status)) })
      .catch(() => { if (Date.now() > deadline) process.exit(1); setTimeout(once, 1000) })
    once()
  ' "$SERVER_URL" "${1:-60}"
}

phase service
if [[ $PLATFORM == linux ]]; then
  systemctl --user show-environment >/dev/null 2>&1 \
    || fail no-service-manager "No systemd user manager for $USER: log in over SSH as this user (not su or sudo), or run with --no-service"
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != yes ]]; then
    loginctl enable-linger "$USER" 2>/dev/null \
      || warn "Lingering is off, so the server stops when you log out. Turn it on with: sudo loginctl enable-linger $USER"
  fi
else
  launchctl print "gui/$(id -u)" >/dev/null 2>&1 \
    || fail no-login-session "No login session for $USER: a launchd agent needs the user logged in on the Mac (auto-login for a headless Mac), or run with --no-service"
fi

# A run with nothing new leaves a running server alone: a restart ends its sessions.
SERVICE_TEXT="$(render_service)"
OLD_SERVICE_TEXT="$(cat "$SERVICE_FILE" 2>/dev/null || true)"
RUNNING=0
service_active && RUNNING=1
if [[ $UPDATED -eq 0 && $RUNNING -eq 1 && "$SERVICE_TEXT" == "$OLD_SERVICE_TEXT" ]] && wait_healthy 2; then
  save_options
  info "Clave server $REF is up to date and running on $SERVER_URL"
  warn_missing_agents
  exit 0
fi

if [[ $RUNNING -eq 1 ]]; then
  warn "Restarting the server: its running sessions end, and come back as ended tabs to Resume"
fi
phase restart
stop_service
ROLLBACK_CURRENT="$CURRENT"
ROLLBACK_PREVIOUS=''
[[ -L "$PREVIOUS_LINK" ]] && ROLLBACK_PREVIOUS="$(readlink "$PREVIOUS_LINK")"
switch_to "$RELEASE"
phase service
write_service
phase restart
start_service || true

# Going back restores the release and the service as they were, options included.
phase health
if ! wait_healthy; then
  if [[ -z "$ROLLBACK_CURRENT" || -z "$OLD_SERVICE_TEXT" ]]; then
    stop_service
    fail server-did-not-answer "The server did not answer on $SERVER_URL within a minute, and is stopped. Logs: $(logs_hint)"
  fi
  phase rollback
  back="$(cat "$ROLLBACK_CURRENT/.clave-ref" 2>/dev/null || basename "$ROLLBACK_CURRENT")"
  warn "$REF did not answer on $SERVER_URL within a minute; going back to $back as it ran before"
  stop_service
  if [[ "$ROLLBACK_CURRENT" != "$RELEASE" ]]; then
    CURRENT=''
    switch_to "$ROLLBACK_CURRENT"
    if [[ -n "$ROLLBACK_PREVIOUS" ]]; then ln -sfn "$ROLLBACK_PREVIOUS" "$PREVIOUS_LINK"; else rm -f "$PREVIOUS_LINK"; fi
    rm -rf "$RELEASE"
  fi
  SERVICE_TEXT="$OLD_SERVICE_TEXT"
  write_service
  start_service || true
  [[ -n "$CLAVE_URL" ]] && SERVER_URL="$CLAVE_URL"
  wait_healthy || fail rollback-failed "$back does not answer either. Logs: $(logs_hint)"
  fail rolled-back "$REF did not start with these options, and the server is back on $back at $SERVER_URL. Logs: $(logs_hint)"
fi
prune_releases
save_options

IDENTITY="$CLAVE_DATA_DIR/daemon/identity.json"
info "Clave server $REF is running on $SERVER_URL"
if [[ "$LISTEN_HOST" == 127.0.0.1 ]]; then
  info "It listens on loopback only; reach it from your Mac through an SSH tunnel: ssh -N -L $CLAVE_PORT:127.0.0.1:$CLAVE_PORT $USER@<this machine>"
fi
if [[ $FIRST_INSTALL -eq 1 ]]; then
  info "Add it in Clave (sidebar, Servers) with the token read on this machine by:"
  echo "  node -p 'require(\"$IDENTITY\").token'"
  info "Update it later by running this script again."
fi
warn_missing_agents
info "Logs: $(logs_hint)"
