// flag-monitor: emits "DOWN\n" / "UP\n" to stdout when the Option modifier key
// is held / released globally. Uses NSEvent global monitor which requires
// macOS Accessibility permission. Designed to be spawned as a child process
// by the Electron main process.
//
// Build: swiftc -O -o flag-monitor flag-monitor.swift
//
// Protocol on stdout (line-based):
//   READY\n            — emitted once at startup after the monitor is armed
//   DOWN\n / UP\n      — Option key down / up
//   ERROR_NO_TRUST\n   — emitted if Accessibility is not granted; then exit 2
// Stderr is used for human-readable diagnostics.

import AppKit
import ApplicationServices
import Foundation

setbuf(stdout, nil)
setbuf(stderr, nil)

func log(_ s: String) {
  FileHandle.standardError.write("flag-monitor: \(s)\n".data(using: .utf8)!)
}

// Required so AppKit event delivery works in a headless CLI tool.
// Set BEFORE adding the monitor.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Check Accessibility permission. If not trusted, prompt and exit so the
// parent can surface a clear error.
let trustedNow = AXIsProcessTrusted()
log("AXIsProcessTrusted at start: \(trustedNow)")
if !trustedNow {
  let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  let options: NSDictionary = [promptKey: true]
  let trustedAfterPrompt = AXIsProcessTrustedWithOptions(options)
  log("AXIsProcessTrustedWithOptions(prompt: true) → \(trustedAfterPrompt)")
  if !trustedAfterPrompt {
    print("ERROR_NO_TRUST")
    exit(2)
  }
}

var lastOptionDown = false

let monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
  let isOptionDown = event.modifierFlags.contains(.option)
  if isOptionDown && !lastOptionDown {
    print("DOWN")
  } else if !isOptionDown && lastOptionDown {
    print("UP")
  }
  lastOptionDown = isOptionDown
}

if monitor == nil {
  log("addGlobalMonitorForEvents returned nil — monitor was not installed")
  print("ERROR_NO_TRUST")
  exit(2)
}

log("monitor installed; entering run loop")
print("READY")

RunLoop.main.run()
