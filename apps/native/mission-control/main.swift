// Mission Control detector for Clave.
//
// Watches the window server's catenated transform of a target window via the
// private SkyLight framework: outside Mission Control the transform is the
// identity; the instant Mission Control (or App Exposé) lays windows out in
// its grid, the window server multiplies in a scale, so the transform
// deviating from identity is the "entered" signal. Note the transform maps
// screen space back to window space, so shrinking the window into the grid
// shows up as scale factors ABOVE 1 (~4.5 for a full-screen window), rising
// during the entry animation and falling back to 1 on exit. CGS notification
// 1328 gives an immediate "exited" signal; polling covers both edges
// regardless.
//
// All private symbols are resolved with dlopen/dlsym so the binary carries no
// load command against a private framework and degrades to a clean
// `registered: false` if a future macOS removes them.
//
// Protocol (newline-delimited JSON):
//   stdin  ← {"cmd":"set-target-window","windowId":<CGWindowID>}
//   stdin  ← {"cmd":"shutdown"}
//   stdout → {"event":"initialized","registered":true|false}
//   stdout → {"event":"entered"} / {"event":"exited"}

import CoreGraphics
import Foundation

private typealias SLSMainConnectionIDFn = @convention(c) () -> Int32
private typealias SLSGetCatenatedWindowTransformFn = @convention(c) (
    Int32, UInt32, UnsafeMutablePointer<CGAffineTransform>
) -> Int32
private typealias CGSNotifyProcPtr = UnsafeMutableRawPointer
private typealias CGSRegisterNotifyProcFn = @convention(c) (
    CGSNotifyProcPtr, UInt32, UnsafeMutableRawPointer?
) -> Int32

private let kCGSMissionControlExited: UInt32 = 1328
private let skyLightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight"
private let pollInterval: TimeInterval = 0.066
private let scaleTolerance: CGFloat = 0.001

setbuf(stdout, nil)

private func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

// MARK: - Resolve private symbols

guard let skyLight = dlopen(skyLightPath, RTLD_LAZY),
      let mainConnectionSym = dlsym(skyLight, "SLSMainConnectionID"),
      let getTransformSym = dlsym(skyLight, "SLSGetCatenatedWindowTransform")
else {
    emit(["event": "initialized", "registered": false])
    exit(0)
}

private let mainConnectionID = unsafeBitCast(mainConnectionSym, to: SLSMainConnectionIDFn.self)
private let getCatenatedWindowTransform = unsafeBitCast(
    getTransformSym, to: SLSGetCatenatedWindowTransformFn.self
)
private let connectionID = mainConnectionID()

// MARK: - State (main runloop thread only)

var targetWindowID: UInt32?
var missionControlActive = false
var pendingScaledTicks = 0
var peakDeviation: CGFloat = 0
var waitingForIdentity = false
var identityGrowthTicks = 0
var previousDeviation: CGFloat = 0

/// Exit is "deviation fell below this fraction of its peak" — far enough that
/// the thumbnail hover zoom (a few percent) can never trigger it.
private let exitFraction: CGFloat = 0.5
private let reentryGrowthEpsilon: CGFloat = 0.01

private func setActive(_ active: Bool) {
    guard active != missionControlActive else { return }
    missionControlActive = active
    emit(["event": active ? "entered" : "exited"])
}

/// Transform is back at (or lost to) identity — full reset.
func resetToIdle() {
    pendingScaledTicks = 0
    peakDeviation = 0
    waitingForIdentity = false
    identityGrowthTicks = 0
    setActive(false)
}

/// Hide now and stay hidden until the transform returns to identity, so the
/// still-scaled ticks of the exit animation can't re-show the overlay.
func hideUntilIdentity() {
    pendingScaledTicks = 0
    peakDeviation = 0
    identityGrowthTicks = 0
    waitingForIdentity = true
    setActive(false)
}

// MARK: - Transform polling

private func pollTransform() {
    // Orphan guard: if the parent Electron process died without sending
    // shutdown (crash, SIGKILL), we get reparented to launchd — exit.
    if getppid() == 1 { exit(0) }
    guard let windowID = targetWindowID else { return }
    var transform = CGAffineTransform.identity
    guard getCatenatedWindowTransform(connectionID, windowID, &transform) == 0 else {
        // Stale/invalid window id — treat as not scaled.
        resetToIdle()
        return
    }
    let deviation = max(abs(transform.a - 1), abs(transform.d - 1))
    defer { previousDeviation = deviation }
    if deviation <= scaleTolerance {
        resetToIdle()
        return
    }
    if waitingForIdentity {
        // Exit-animation tail: stay hidden. Only a sustained *growing*
        // deviation (Mission Control re-entered before the exit animation
        // finished) re-arms detection early.
        if deviation > previousDeviation + reentryGrowthEpsilon {
            identityGrowthTicks += 1
            if identityGrowthTicks >= 2 { waitingForIdentity = false }
        } else {
            identityGrowthTicks = 0
        }
        return
    }
    peakDeviation = max(peakDeviation, deviation)
    // Exit animation: the transform heads back toward identity. Hide as soon
    // as the deviation has lost half its peak rather than waiting for
    // identity, so the overlay is gone while the window flies back.
    if missionControlActive && deviation < peakDeviation * exitFraction {
        hideUntilIdentity()
        return
    }
    // Debounce one tick so transient window-server animations don't flash the overlay.
    pendingScaledTicks += 1
    if pendingScaledTicks >= 2 { setActive(true) }
}

let timer = CFRunLoopTimerCreateWithHandler(
    kCFAllocatorDefault,
    CFAbsoluteTimeGetCurrent() + pollInterval,
    pollInterval, 0, 0
) { _ in pollTransform() }
CFRunLoopAddTimer(CFRunLoopGetMain(), timer, .commonModes)

// MARK: - CGS "Mission Control exited" notification (belt-and-braces exit edge)

private let missionControlExitedProc: @convention(c) (
    UInt32, UnsafeMutableRawPointer?, UInt32, UnsafeMutableRawPointer?
) -> Void = { _, _, _, _ in
    CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
        hideUntilIdentity()
    }
    CFRunLoopWakeUp(CFRunLoopGetMain())
}

if let registerSym = dlsym(skyLight, "CGSRegisterNotifyProc") {
    let registerNotifyProc = unsafeBitCast(registerSym, to: CGSRegisterNotifyProcFn.self)
    _ = registerNotifyProc(
        unsafeBitCast(missionControlExitedProc, to: UnsafeMutableRawPointer.self),
        kCGSMissionControlExited, nil
    )
}

// MARK: - stdin command loop

FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    if data.isEmpty {
        // Parent closed stdin (crashed or quit) — exit rather than linger.
        CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) { exit(0) }
        CFRunLoopWakeUp(CFRunLoopGetMain())
        return
    }
    for line in data.split(separator: UInt8(ascii: "\n")) {
        guard let json = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
              let cmd = json["cmd"] as? String else { continue }
        CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
            switch cmd {
            case "set-target-window":
                if let windowID = json["windowId"] as? UInt32 {
                    targetWindowID = windowID
                } else if let windowID = json["windowId"] as? Int, windowID > 0 {
                    targetWindowID = UInt32(windowID)
                }
            case "shutdown":
                exit(0)
            default:
                break
            }
        }
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }
}

emit(["event": "initialized", "registered": true])
CFRunLoopRun()
