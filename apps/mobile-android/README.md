# Clave on Android

The native Android companion of Clave: Kotlin and Jetpack Compose, its own Gradle build in
this folder, speaking the server's wire contract exactly as the Mac does (`docs/mobile*.md`
at the repository root). No React Native, no JavaScript engine, no WebView-rendered screen.

- Application id `com.clave.app.android` (`com.clave.app.android.debug` for a debug build);
  never the prototype's `com.clave.app.mobile` nor the Mac's `com.clave.app`.
- Sign-in through the system browser (Chrome Custom Tabs) with PKCE; the way back is
  `clave-android://oauth/callback`.
- Credentials behind the Android Keystore, namespaced per owner (issuer and subject),
  apart from the plain store of settings, drafts and records.
- Release networking is https only; a debug build may reach plain http on `127.0.0.1`
  (the fixture issuer, relay and server on the Mac through `adb reverse`).

## The toolchain, pinned

| Piece | Version | Where it is read from |
| --- | --- | --- |
| Android Gradle plugin | 9.3.1 | `gradle/libs.versions.toml` |
| Gradle | 9.7.0 | `gradle/wrapper/gradle-wrapper.properties` (with its sha256) |
| Kotlin, Compose compiler plugin | 2.4.21 | `gradle/libs.versions.toml` |
| JDK | 21 | `JAVA_HOME` (Homebrew's `openjdk@21` on the Mac, temurin on CI) |
| compileSdk / build tools | 36 / 36.0.0 | `app/build.gradle.kts`, `ui/build.gradle.kts`, `ci.sh` |
| Compose BOM | 2026.09.00 | `gradle/libs.versions.toml` |

Why these: the Kotlin Gradle plugin 2.4.21 row of the published matrix supports Gradle up to
9.7.0 and AGP up to 9.3.1; AGP's own table wants JDK 17+ and build tools 36.0.0. The external
Kotlin plugin runs on AGP's legacy DSL (`android.newDsl=false`, `android.builtInKotlin=false`
in `gradle.properties`), because AGP 9.3.1 embeds Kotlin 2.2.10 and the Compose libraries of
2026 carry newer metadata; the move to built-in Kotlin is owed before AGP 10.

### Bootstrapping on a Mac that has no command-line tools

The Mac's `/usr/bin/java` is Apple's stub, Gradle is absent and the SDK under
`~/Library/Android/sdk` has no `cmdline-tools`. Nothing global is written: the toolchain
lives in a private folder (`TOOLCHAIN=~/.local/share/<your folder>/android-toolchain`).

A JDK 21 is used read-only, never installed by this bootstrap: Homebrew's
`/opt/homebrew/opt/openjdk@21` when the machine has it (a `brew install openjdk@21` is the
reader's own, optional, global setup, outside this bootstrap), otherwise a pinned Temurin 21
archive downloaded into `$TOOLCHAIN/jdk` with its published checksum verified before it is
unpacked, and `JAVA_HOME` pointing at it.

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21   # or $TOOLCHAIN/jdk/<the pinned Temurin 21>
# command-line tools 23.0, checksum from https://dl.google.com/android/repository/repository2-3.xml
curl -L -o cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-mac_arm64-16111833_latest.zip
echo "ad03dc49bfacfd52c110b14104ea548b8a07e830  cmdline-tools.zip" | shasum -a 1 -c -
mkdir -p "$TOOLCHAIN/sdk/cmdline-tools" && unzip -q cmdline-tools.zip -d /tmp/ct && mv /tmp/ct/cmdline-tools "$TOOLCHAIN/sdk/cmdline-tools/latest"
export ANDROID_HOME="$TOOLCHAIN/sdk" ANDROID_SDK_ROOT="$TOOLCHAIN/sdk" GRADLE_USER_HOME="$TOOLCHAIN/gradle"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "platforms;android-36" "build-tools;36.0.0" "platform-tools" "emulator" "system-images;android-36.1;google_apis_playstore;arm64-v8a"
echo "sdk.dir=$ANDROID_HOME" > local.properties   # gitignored
```

The lane of 9 November 2026 copied the platform, the build tools and the platform tools from
the Mac's existing SDK into the private root instead of downloading them again, and linked the
system image and the emulator read-only; the versions and checksums are in its record.

## Build, test, run

From this folder, with `JAVA_HOME`, `ANDROID_HOME` and `GRADLE_USER_HOME` exported (the Gradle
wrapper downloads Gradle 9.7.0 once and verifies its checksum):

```sh
./gradlew assembleDebug                      # app/build/outputs/apk/debug/app-debug.apk
./gradlew test                               # every JVM unit test (core modules, ui)
./gradlew :core:contract:test :core:auth:test :core:transport:test :core:chat:test \
          :core:devices:test :core:notifications:test :core:state:test :ui:testDebugUnitTest
bash ci.sh                                   # what the Linux CI job runs: the SDK pieces, every JVM test, the APK
```

A virtual device of your own, with fresh data, in a private AVD home (never the person's):

```sh
export ANDROID_AVD_HOME="$TOOLCHAIN/avd"
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n clave-native-b \
  -k "system-images;android-36.1;google_apis_playstore;arm64-v8a" -d medium_phone
"$ANDROID_HOME/emulator/emulator" -avd clave-native-b -port 5562 &     # serial emulator-5562, console 5563
adb -s emulator-5562 wait-for-device
adb -s emulator-5562 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5562 shell am start -n com.clave.app.android.debug/com.clave.android.MainActivity
```

The instrumented tests (the platform adapters, the Compose screens and the fixture check) run
on that emulator:

```sh
./gradlew :platform:connectedDebugAndroidTest :ui:connectedDebugAndroidTest :app:connectedDebugAndroidTest
```

The modules: `core/*` are pure JVM (the contract mirror, the sign-in, the transport, the
conversation logic, the devices, the notifications, the state store), `ui` is the design
system and the screens (stateless, state classes and callbacks), `platform` holds the
adapters behind the core's ports (the Keystore, the preferences, the system browser, OkHttp,
the notification channel, Firebase's token, the content resolver), and `app` composes them.

Stop only your own device: `adb -s emulator-5562 emu kill`; delete only your own AVD:
`avdmanager delete avd -n clave-native-b`.

## The fixture environment (development and test only)

The app's default configuration reaches Clave's real API through the team relay and the
Antasphere hub. The fixture is an explicit development configuration: this checkout's own
server as a daemon with the Echo adapter, a local relay and the local OpenID Connect provider
of `tests/e2e/fixtures/oidc-provider.mjs`, all on the Mac's loopback, reached from the
emulator through `adb reverse`. `scripts/fixture-env.mjs` starts them on one band and writes
`<tmpdir>/fixture.json`; `scripts/fixture-env.mjs --check` proves the pairing and the Echo
chat over HTTP the way the phone does. A result on the Echo adapter proves the protocol,
never a real provider and never a physical phone.

```sh
node apps/mobile-android/scripts/fixture-env.mjs --server 47201 --relay 47202 --issuer 47203 --tmpdir /private/tmp/clave-native-b/fixture --dry-run
node apps/mobile-android/scripts/fixture-env.mjs --server 47201 --relay 47202 --issuer 47203 --tmpdir /private/tmp/clave-native-b/fixture --approve
adb -s emulator-5562 reverse tcp:47201 tcp:47201 && adb -s emulator-5562 reverse tcp:47202 tcp:47202 && adb -s emulator-5562 reverse tcp:47203 tcp:47203
```

The daemon runs with `--no-titles --test-no-activate --test-no-machine-usage`, so it names no
chat with a real agent, runs no usage clock and reads no machine login. The runner proves that
stance three times and refuses to boot otherwise (exit 2). Before anything starts: the three
flags are in the daemon's argv; its environment is an allowlist of the shell's keys plus the
fixture's own (the recorders first on PATH, the fixture's login shell as SHELL, empty Claude and
Codex homes); its login environment, read as the daemon reads it (`$SHELL -lic 'env -0'`),
resolves `claude` and `codex` to the fixture's recorders; and the recorder itself, run with
`--version`, writes one line to the fixture's own log. After the daemon announces itself and
before any sign-in or chat, inside the daemon through its test route: the discovery file says
`titles: "off"`, `testMode: true` and `machineUsage: false`, and the title module's own test
hooks (`__claveE2E.titles`) say the opt-out is `--no-titles`, locate both commands on the cached
login PATH to the recorders, and answer the one-shot's launch as the recorder by canonical path;
nothing is executed. For the whole run, in every mode, the recorder log is watched: a line that
is not the self-test's, or a log gone missing, unreadable or truncated, stops everything with
exit 3. The run folder is the runner's own (a marker it wrote; anything else is refused
untouched). `--dry-run` runs the pre-boot checks alone, reads the run folder only and starts
nothing; `--dry-run --mutate recorder-removed|recorder-unreadable|recorder-truncated` shows the
guard latch; `--dry-run --red-flags|--red-interlock` shows two pre-boot checks go red; the
daemon-side faults (`--mutate divergent-cache|wrong-resolver`, and the positive control
`decoy-on-process-path`) run under `--check` only. The shared fixture lane C ships
(`packages/mobile-native/scripts/fixture-server.mjs`) runs the same three boot checks.

## What a release APK needs, named apart

A release build (`./gradlew assembleRelease`) is unsigned here: it needs the team's keystore
(`MOBILE_ANDROID_KEYSTORE`, its alias and passwords through files, never arguments), which
nobody on this Mac holds. Push delivery needs the team's Firebase project (its
`app/google-services.json`, gitignored) and the server's `push/fcm-service-account.json`; the
handling is built, the delivery is unverified end to end. Acceptance on a physical phone was
not run: no device is connected and the person's phone is never installed on.

## Licenses

Geist Sans (OFL, `ui/LICENSES/OFL-Geist.txt`), Heroicons (MIT, `ui/LICENSES/MIT-Heroicons.txt`),
both from the same packages the desktop app loads; the provider marks are the desktop's own.
