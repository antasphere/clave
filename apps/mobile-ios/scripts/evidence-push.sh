#!/bin/zsh
# Sends the two pushes of the push evidence (ClaveUITests/NotificationEvidenceTests,
# testAPushBannerOpensItsScreen) to ONE simulator, each when the running test asks for it by
# writing a marker file: ready-chat, then ready-requests, under the evidence folder. The
# payloads follow docs/mobile-push.md (aps with the category clave.<kind>, Clave's payload under
# the clave key) and name the in-process fake's server, srv_fake, which the phone resolves to
# the paired machine m_fake. Nothing here reaches a network: `simctl push` hands the payload to
# the simulator.
#
#   CLAVE_IOS_SIMULATOR_UDID=<udid> zsh scripts/evidence-push.sh &
#   xcodebuild ... test -only-testing:ClaveUITests/NotificationEvidenceTests/testAPushBannerOpensItsScreen
#
# Exits 0 once both pushes are sent, 1 when a push fails, 2 when the test never asks
# (CLAVE_IOS_EVIDENCE_PUSH_WAIT seconds per push, 600 by default; raise it beside a full run).
set -u

udid=${CLAVE_IOS_SIMULATOR_UDID:?CLAVE_IOS_SIMULATOR_UDID must name the one simulator to push to}
dir=${CLAVE_IOS_EVIDENCE_PUSH_DIR:-/private/tmp/clave-native-a/evidence/push}
bundle=com.clave.ios.dev
limit=${CLAVE_IOS_EVIDENCE_PUSH_WAIT:-600}
mkdir -p "$dir"

# A finished session: the banner opens its conversation.
cat > "$dir/chat.json" <<'JSON'
{
  "aps": {
    "alert": { "title": "Seeded chat", "subtitle": "Fake Mac", "body": "Evidence push: Seeded chat finished" },
    "sound": "default",
    "category": "clave.finished",
    "thread-id": "s_fake"
  },
  "clave": {
    "category": "finished", "serverId": "srv_fake", "serverName": "Fake Mac",
    "sessionId": "s_fake", "sessionTitle": "Seeded chat", "workspaceName": "scratch",
    "text": "Seeded chat finished", "actions": ["open"]
  }
}
JSON

# A question whose conversation the machine no longer has: the banner opens the requests.
cat > "$dir/requests.json" <<'JSON'
{
  "aps": {
    "alert": { "title": "Gone chat", "subtitle": "Fake Mac", "body": "Evidence push: Which file should Echo read?" },
    "sound": "default",
    "category": "clave.question",
    "thread-id": "s_gone"
  },
  "clave": {
    "category": "question", "serverId": "srv_fake", "serverName": "Fake Mac",
    "sessionId": "s_gone", "sessionTitle": "Gone chat", "workspaceName": "scratch",
    "requestId": "r_fake", "text": "Which file should Echo read?", "actions": ["reply", "open"]
  }
}
JSON

rm -f "$dir"/ready-* "$dir"/sent-*
for name in chat requests; do
  waited=0
  until [[ -f "$dir/ready-$name" ]]; do
    if (( waited >= limit )); then
      print -u2 "evidence-push: the test never asked for the $name push"
      exit 2
    fi
    sleep 1
    (( waited += 1 ))
  done
  if ! xcrun simctl push "$udid" "$bundle" "$dir/$name.json"; then
    print -u2 "evidence-push: simctl push failed for $name"
    exit 1
  fi
  touch "$dir/sent-$name"
  print "evidence-push: sent $name"
done
