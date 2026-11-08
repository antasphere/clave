// Trackpad haptics for Clave.
//
// Electron has no way to reach NSHapticFeedbackManager, so this helper stays
// resident and performs one feedback pattern per line it reads on stdin. The
// sidebar uses it to tick the trackpad each time the drop line moves to a new
// row while dragging — the same "alignment" snap Finder and Xcode give.
//
// Protocol (one word per line on stdin): "alignment" | "generic" | "level".
// Unknown words are ignored; EOF exits. On a machine without a Force Touch
// trackpad the calls are silent no-ops, which is the right degradation.

import AppKit
import Foundation

let performer = NSHapticFeedbackManager.defaultPerformer

while let line = readLine(strippingNewline: true) {
    switch line {
    case "alignment":
        performer.perform(.alignment, performanceTime: .now)
    case "generic":
        performer.perform(.generic, performanceTime: .now)
    case "level":
        performer.perform(.levelChange, performanceTime: .now)
    default:
        continue
    }
}
