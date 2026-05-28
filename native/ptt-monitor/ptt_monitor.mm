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

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <CoreAudio/CoreAudio.h>
#include <napi.h>

static id g_flagsMonitor = nil;
static id g_keyMonitor = nil;
static BOOL g_lastOption = NO;
static Napi::ThreadSafeFunction g_tsfn;
static bool g_tsfn_active = false;

static void emitState(const std::string& state) {
  if (!g_tsfn_active) return;
  auto callback = [state](Napi::Env env, Napi::Function jsCallback) {
    jsCallback.Call({Napi::String::New(env, state)});
  };
  g_tsfn.NonBlockingCall(callback);
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
  g_lastOption = NO;

  g_flagsMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskFlagsChanged
                                                          handler:^(NSEvent* event) {
    BOOL isOption = (event.modifierFlags & NSEventModifierFlagOption) != 0;
    if (isOption == g_lastOption) {
      return;
    }
    g_lastOption = isOption;
    emitState(isOption ? "DOWN" : "UP");
  }];

  // Watch keyDown globally too: if a regular key fires while Option is held,
  // emit CHORD so the host treats it as a keyboard shortcut and not as PTT.
  g_keyMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                         handler:^(NSEvent* event) {
    if (!g_lastOption) return;
    // Ignore key-repeat: only the first keyDown of a chord matters.
    if (event.isARepeat) return;
    emitState("CHORD");
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
  if (g_tsfn_active) {
    g_tsfn_active = false;
    g_tsfn.Release();
  }
  g_lastOption = NO;
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
