// ptt_monitor: in-process NSEvent global monitor for the Option modifier key.
//
// Runs in the Electron main process so TCC sees a single Accessibility entry
// (open-flow.app) — no separate child binary that would need its own grant.
//
// JS API:
//   const ptt = require('./build/Release/ptt_monitor.node');
//   ptt.start((state) => { /* state is "DOWN" / "UP" / "CHORD" */ });
//   ptt.stop();
//   ptt.isTrusted() // → boolean
//   ptt.requestTrust() // → boolean (prompts macOS)
//
// "CHORD" fires when a non-modifier key is pressed while Option is held —
// signal to the host that Option is being used as part of a keyboard shortcut
// (e.g. Option+arrow, Option+Cmd+I) and PTT recording must NOT trigger.
//
// "DESYNC" is diagnostic only. g_lastOption is edge-derived from flagsChanged,
// but an NSEvent global monitor never sees events routed to our own windows,
// nor anything at all while another app has Secure Event Input engaged (password
// fields). A dropped edge inverts the cached polarity, so the NEXT Option press
// emits nothing at all — the user holds the key and no dictation starts, with no
// trace in the log. DESYNC compares the cache against the live modifier flags
// and reports the disagreement so that failure becomes visible. The host must
// treat it as observation only and never let it drive the PTT state machine.

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <CoreAudio/CoreAudio.h>
#include <napi.h>

static id g_flagsMonitor = nil;
static id g_keyMonitor = nil;
static NSTimer* g_desyncTimer = nil;
static BOOL g_lastOption = NO;
static BOOL g_desyncReported = NO;
static Napi::ThreadSafeFunction g_tsfn;
static bool g_tsfn_active = false;

static void emitState(const std::string& state, const std::string& detail) {
  if (!g_tsfn_active) return;
  auto callback = [state, detail](Napi::Env env, Napi::Function jsCallback) {
    jsCallback.Call({Napi::String::New(env, state), Napi::String::New(env, detail)});
  };
  g_tsfn.NonBlockingCall(callback);
}

/** Live Option state straight from the window server, independent of the event
 *  stream we may have missed. This is the ground truth g_lastOption is checked
 *  against. */
static BOOL liveOptionDown() {
  return ([NSEvent modifierFlags] & NSEventModifierFlagOption) != 0;
}

/** Emit DESYNC when the cached and live Option states disagree, but only on the
 *  leading edge of the disagreement so a sustained mismatch logs once instead of
 *  every tick. `context` names what noticed it. Returns YES if desynced. */
static BOOL reportDesyncIfAny(const char* context, const std::string& extra) {
  BOOL live = liveOptionDown();
  if (live == g_lastOption) {
    g_desyncReported = NO;
    return NO;
  }
  if (!g_desyncReported) {
    g_desyncReported = YES;
    char buf[256];
    snprintf(buf, sizeof(buf), "via=%s cached=%d live=%d%s%s",
             context, (int)g_lastOption, (int)live,
             extra.empty() ? "" : " ", extra.c_str());
    emitState("DESYNC", buf);
  }
  return YES;
}

/** Human-readable identity of the key that produced a CHORD. keyCode is the
 *  decisive field: it says whether a real shortcut key was pressed or whether
 *  the CHORD was spurious. characters are included only when printable ASCII,
 *  so arrow/function keys don't inject control bytes into the log. */
static std::string describeKey(NSEvent* event) {
  char chars[8] = {0};
  NSString* raw = event.charactersIgnoringModifiers;
  if (raw.length == 1) {
    unichar c = [raw characterAtIndex:0];
    if (c >= 0x20 && c < 0x7f) snprintf(chars, sizeof(chars), "%c", (char)c);
  }
  char buf[192];
  snprintf(buf, sizeof(buf), "keyCode=%u chars=%s repeat=%d flags=0x%lx",
           (unsigned)event.keyCode, chars[0] ? chars : "-",
           (int)event.isARepeat, (unsigned long)event.modifierFlags);
  return std::string(buf);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_flagsMonitor != nil) {
    return Napi::Boolean::New(env, true);
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "Expected a callback function").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Function cb = info[0].As<Napi::Function>();
  g_tsfn = Napi::ThreadSafeFunction::New(env, cb, "ptt_monitor_callback", 0, 1);
  g_tsfn_active = true;
  g_lastOption = liveOptionDown();
  g_desyncReported = NO;

  g_flagsMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                                          handler:^(NSEvent* event) {
    BOOL isOption = (event.modifierFlags & NSEventModifierFlagOption) != 0;
    if (isOption == g_lastOption) {
      return;
    }
    g_lastOption = isOption;
    g_desyncReported = NO;
    char buf[64];
    snprintf(buf, sizeof(buf), "flags=0x%lx", (unsigned long)event.modifierFlags);
    emitState(isOption ? "DOWN" : "UP", buf);
  }];

  // Watch keyDown globally too: if a regular key fires while Option is held,
  // emit CHORD so the host treats it as a keyboard shortcut and not as PTT.
  g_keyMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                         handler:^(NSEvent* event) {
    // Check for a dropped flagsChanged edge before the gate below, so a CHORD
    // suppressed by a stale cache is still visible in the log.
    reportDesyncIfAny("keyDown", describeKey(event));
    if (!g_lastOption) return;
    // Ignore key-repeat: only the first keyDown of a chord matters.
    if (event.isARepeat) return;
    emitState("CHORD", describeKey(event));
  }];

  // A dropped edge with no typing in between is invisible to the keyDown check
  // above — and that is exactly the failing dictation case, where the user holds
  // Option and presses nothing else. This poll makes it observable. It only ever
  // emits DESYNC; it never repairs g_lastOption, so the monitor's behaviour is
  // unchanged and the diagnosis stays honest.
  g_desyncTimer = [NSTimer scheduledTimerWithTimeInterval:0.5
                                                  repeats:YES
                                                    block:^(NSTimer* timer) {
    (void)timer;
    reportDesyncIfAny("poll", "");
  }];

  return Napi::Boolean::New(env, g_flagsMonitor != nil);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_flagsMonitor != nil) {
    [NSEvent removeMonitor:g_flagsMonitor];
    g_flagsMonitor = nil;
  }
  if (g_keyMonitor != nil) {
    [NSEvent removeMonitor:g_keyMonitor];
    g_keyMonitor = nil;
  }
  if (g_desyncTimer != nil) {
    [g_desyncTimer invalidate];
    g_desyncTimer = nil;
  }
  if (g_tsfn_active) {
    g_tsfn_active = false;
    g_tsfn.Release();
  }
  g_lastOption = NO;
  g_desyncReported = NO;
  return env.Undefined();
}

Napi::Value IsTrusted(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool trusted = AXIsProcessTrusted();
  return Napi::Boolean::New(env, trusted);
}

Napi::Value RequestTrust(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CFStringRef key = kAXTrustedCheckOptionPrompt;
  CFTypeRef values[] = { kCFBooleanTrue };
  CFDictionaryRef options = CFDictionaryCreate(NULL, (const void**)&key, values, 1, NULL, NULL);
  bool trusted = AXIsProcessTrustedWithOptions(options);
  CFRelease(options);
  return Napi::Boolean::New(env, trusted);
}

// Returns true iff something is actively flowing through the current default
// output device — i.e. another process is playing audio. Uses the public
// CoreAudio property kAudioDevicePropertyDeviceIsRunningSomewhere, which
// reports activity across ALL processes (not just the caller).
Napi::Value IsAudioOutputRunning(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  AudioObjectPropertyAddress defaultOutAddr = {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    0  // kAudioObjectPropertyElementMain on macOS 12+, value is 0 on all SDKs
  };
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  OSStatus s = AudioObjectGetPropertyData(
    kAudioObjectSystemObject, &defaultOutAddr, 0, NULL, &size, &device);
  if (s != noErr || device == kAudioObjectUnknown) {
    return Napi::Boolean::New(env, false);
  }

  AudioObjectPropertyAddress isRunningAddr = {
    kAudioDevicePropertyDeviceIsRunningSomewhere,
    kAudioObjectPropertyScopeGlobal,
    0
  };
  UInt32 isRunning = 0;
  size = sizeof(isRunning);
  s = AudioObjectGetPropertyData(device, &isRunningAddr, 0, NULL, &size, &isRunning);
  if (s != noErr) {
    return Napi::Boolean::New(env, false);
  }
  return Napi::Boolean::New(env, isRunning != 0);
}

// Posts a system Play/Pause media key (the same event the keyboard's hardware
// Play/Pause key generates). macOS routes it to the current Now Playing app,
// so it pauses Spotify / Music / Safari & Chrome video / QuickTime / Podcasts
// etc. A second invocation toggles back to playing. If no app is registered
// as Now Playing, the event is harmlessly dropped.
Napi::Value PostMediaPlayPause(const Napi::CallbackInfo& info) {
  // Constants from IOKit/hidsystem/ev_keymap.h, inlined to avoid pulling the
  // header (and a framework link) just for two numbers.
  static const int NX_KEYTYPE_PLAY = 16;
  static const int kSubtypeAuxControlButtons = 8;

  // Emit key down (0xA) then key up (0xB) — both are needed for the system
  // to register a media-key press.
  for (int state : { 0xA, 0xB }) {
    // 0xA00 is the modifier-flag value emitted by hardware media keys; not a
    // CGEventFlags mask — lives in NSEvent's modifier-flag bit space.
    NSEvent *ev = [NSEvent otherEventWithType:NSEventTypeSystemDefined
                                     location:NSZeroPoint
                                modifierFlags:0xA00
                                    timestamp:0
                                 windowNumber:0
                                      context:nil
                                      subtype:kSubtypeAuxControlButtons
                                        data1:(NX_KEYTYPE_PLAY << 16) | (state << 8)
                                        data2:-1];
    CGEventRef cg = [ev CGEvent];
    if (cg) CGEventPost(kCGHIDEventTap, cg);
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isTrusted", Napi::Function::New(env, IsTrusted));
  exports.Set("requestTrust", Napi::Function::New(env, RequestTrust));
  exports.Set("isAudioOutputRunning", Napi::Function::New(env, IsAudioOutputRunning));
  exports.Set("postMediaPlayPause",  Napi::Function::New(env, PostMediaPlayPause));
  return exports;
}

NODE_API_MODULE(ptt_monitor, Init)
