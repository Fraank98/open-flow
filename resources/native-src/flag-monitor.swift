// flag-monitor: emits "DOWN\n" / "UP\n" to stdout when the Option modifier key
// is held / released globally. Uses NSEvent global monitor which requires only
// macOS Accessibility permission (not Input Monitoring). Designed to be
// spawned as a child process by the Electron main process.
//
// Build: swiftc -O -o flag-monitor flag-monitor.swift
//
// The host process reads lines from stdout. Exit by closing stdin or sending
// SIGTERM; the monitor runs RunLoop.main.run() until killed.

import AppKit
import Foundation

var lastOptionDown = false

// Ensure stdout is unbuffered so the host sees events immediately.
setbuf(stdout, nil)

// Background system also captures local events (when our own app is focused),
// but for a menubar app that's never focused, only the global monitor matters.
NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
  let isOptionDown = event.modifierFlags.contains(.option)
  if isOptionDown && !lastOptionDown {
    print("DOWN")
  } else if !isOptionDown && lastOptionDown {
    print("UP")
  }
  lastOptionDown = isOptionDown
}

// Required so AppKit event delivery works.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

RunLoop.main.run()
