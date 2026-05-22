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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isTrusted", Napi::Function::New(env, IsTrusted));
  exports.Set("requestTrust", Napi::Function::New(env, RequestTrust));
  return exports;
}

NODE_API_MODULE(ptt_monitor, Init)
