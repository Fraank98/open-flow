// ax_context: reads the Accessibility context under the mouse pointer.
//
// Runs in the Electron main process (same TCC entry as ptt_monitor). Pure data
// collection: no text heuristics live here — they are in
// src/main/utils/conversation-parser.ts, where they are testable.
//
// JS API:
//   const ax = require('./build/Release/ax_context.node');
//   ax.readContextUnderCursor({ maxDepth, maxTotalChars, timeBudgetMs, jumpRatio, jumpMinChars,
//                               bundleIdFilter?: { mode: "allowlist"|"blocklist", bundleIds: string[] } })
//     → NativeContextResult (see src/main/ax-context-reader.ts)
//   ax.activateApp(pid)  → boolean
//   ax.frontmostPid()    → number (-1 if none)
//   ax.isTrusted()       → boolean (AXIsProcessTrusted)

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <napi.h>
#include <string>
#include <vector>

#pragma mark - Budgets and constants

// Per-element AX messaging timeout. A single unresponsive app must not eat the
// whole (default 300 ms) total time budget — the exploration spike used 0.5s,
// which is incompatible with that budget.
static const float kElementTimeoutSec = 0.1f;

// Timeout for the system-wide element used by AXUIElementCopyElementAtPosition
// (28-49 ms measured in the spike; 0.25s leaves generous headroom).
static const float kSystemWideTimeoutSec = 0.25f;

// Max subtree recursion depth collected per ancestor level (spike-tuned).
static const int kSubtreeMaxDepth = 30;

// Max nodes visited per ancestor level (spike-tuned).
static const int kSubtreeMaxNodes = 3000;

// Fragments shorter than this are noise, not content (spike-tuned).
static const NSUInteger kMinFragmentChars = 2;

// Defaults used only when the JS caller omits a field; the TypeScript wrapper
// always passes every option explicitly. These exist so the addon is usable
// on its own (e.g. from a manual smoke test).
static const NSUInteger kDefaultMaxDepth = 8;
static const NSUInteger kDefaultMaxTotalChars = 16000;
static const double kDefaultTimeBudgetMs = 300;
static const double kDefaultJumpRatio = 10;
static const NSUInteger kDefaultJumpMinChars = 400;

#pragma mark - Small helpers

// Reads `attr` off `el`. Accepts CFString and CFNumber (converted via
// -stringValue); nil for anything else, missing attribute, or error. Always
// releases the copied value.
static NSString* stringAttr(AXUIElementRef el, CFStringRef attr) {
  if (!el) return nil;
  CFTypeRef v = NULL;
  if (AXUIElementCopyAttributeValue(el, attr, &v) != kAXErrorSuccess || !v) return nil;
  NSString* out = nil;
  CFTypeID t = CFGetTypeID(v);
  if (t == CFStringGetTypeID()) {
    out = [NSString stringWithString:(__bridge NSString*)v];
  } else if (t == CFNumberGetTypeID()) {
    out = [(__bridge NSNumber*)v stringValue];
  }
  CFRelease(v);
  return out;
}

// Reads `attr` off `el` and returns it only if it is itself an AXUIElement.
// Caller owns the returned reference (CFRelease it).
static AXUIElementRef copyElementAttr(AXUIElementRef el, CFStringRef attr) {
  if (!el) return NULL;
  CFTypeRef v = NULL;
  if (AXUIElementCopyAttributeValue(el, attr, &v) != kAXErrorSuccess || !v) return NULL;
  if (CFGetTypeID(v) != AXUIElementGetTypeID()) {
    CFRelease(v);
    return NULL;
  }
  return (AXUIElementRef)v;
}

static NSString* roleOf(AXUIElementRef el) {
  return stringAttr(el, kAXRoleAttribute) ?: @"?";
}

// Pure UI chrome: its own text is never collected, but its children still are.
static NSSet<NSString*>* chromeRoleSet(void) {
  static NSSet<NSString*>* s = nil;
  if (!s) {
    s = [NSSet setWithArray:@[
      @"AXButton", @"AXMenuItem", @"AXMenuButton", @"AXMenu", @"AXMenuBar", @"AXMenuBarItem",
      @"AXToolbar", @"AXTabGroup", @"AXTab", @"AXRadioButton", @"AXCheckBox", @"AXPopUpButton",
      @"AXImage", @"AXSlider", @"AXIncrementor", @"AXScrollBar", @"AXDisclosureTriangle",
      @"AXProgressIndicator"
    ]];
  }
  return s;
}

static bool isChromeRole(NSString* role) {
  return [chromeRoleSet() containsObject:role];
}

// Mouse location in AX coordinates (origin top-left, multi-monitor aware) —
// no conversion needed. Returns false (and leaves *outP untouched) when the
// window server can't hand back an event — observed under load or without
// window server access — so the caller treats it as "no-element" instead of
// touching a NULL CGEventRef.
static bool cursorPointAX(CGPoint* outP) {
  CGEventRef ev = CGEventCreate(NULL);
  if (!ev) return false;
  *outP = CGEventGetLocation(ev);
  CFRelease(ev);
  return true;
}

static double nowMs(void) {
  return CFAbsoluteTimeGetCurrent() * 1000.0;
}

#pragma mark - Subtree harvest

struct Budget {
  NSUInteger maxTotalChars;
  double deadlineMs;
  // Chars added to fragments across EVERY ancestor level collected so far in
  // this call, not just the current one: maxTotalChars is a cap on what
  // leaves the addon in total. Owned by ReadContextUnderCursor's stack frame,
  // shared by pointer into every collectSubtree call of the whole climb so a
  // fresh per-level Harvest can still see what prior levels already spent.
  NSUInteger* totalCharsSoFar;
};

struct Harvest {
  NSMutableArray<NSString*>* fragments;  // in document order
  NSUInteger chars;                      // sum of fragment lengths (this level only)
  int nodes;
  bool budgetHit;   // maxTotalChars (cumulative) or deadline crossed — aborts the whole climb
  bool truncated;   // hit kSubtreeMaxDepth/kSubtreeMaxNodes — this level's harvest may be
                     // incomplete, but the climb continues; distinct from budgetHit so the
                     // parser/log can tell a capped level from a complete one
};

// Depth-first walk of `el`'s subtree. For every non-chrome node reads
// kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute (in this
// order), trims whitespace, drops fragments shorter than kMinFragmentChars
// and exact duplicates (`seen`), appends to h.fragments and adds the length
// to h.chars and to *b.totalCharsSoFar. Chrome nodes contribute no text but
// their children are still visited.
//
// Stops when depth > kSubtreeMaxDepth or h.nodes >= kSubtreeMaxNodes (sets
// h.truncated; per-level hard stop, does not abort the climb), or when
// *b.totalCharsSoFar reaches b.maxTotalChars / nowMs() > b.deadlineMs (sets
// h.budgetHit, which also short-circuits the rest of this walk and aborts
// the climb). A single fragment that would overrun the remaining budget is
// truncated to the exact number of chars still available rather than
// dropped whole or let through — the cap always holds for what actually
// reaches JS, and hitting it always sets h.budgetHit so the result cannot
// silently claim ok:true while having capped data.
static void collectSubtree(AXUIElementRef el, int depth, Harvest& h, const Budget& b,
                            NSMutableSet<NSString*>* seen) {
  if (!el || h.budgetHit) return;
  if (depth > kSubtreeMaxDepth) {
    h.truncated = true;
    return;
  }
  if (h.nodes >= kSubtreeMaxNodes) {
    h.truncated = true;
    return;
  }
  if (*b.totalCharsSoFar >= b.maxTotalChars) {
    h.budgetHit = true;
    return;
  }
  if (nowMs() > b.deadlineMs) {
    h.budgetHit = true;
    return;
  }

  h.nodes++;
  AXUIElementSetMessagingTimeout(el, kElementTimeoutSec);

  NSString* role = roleOf(el);
  if (!isChromeRole(role)) {
    NSArray<NSString*>* attrs = @[
      (__bridge NSString*)kAXValueAttribute,
      (__bridge NSString*)kAXTitleAttribute,
      (__bridge NSString*)kAXDescriptionAttribute
    ];
    for (NSString* a in attrs) {
      if (h.budgetHit) break;
      NSString* raw = stringAttr(el, (__bridge CFStringRef)a);
      if (!raw) continue;
      NSString* trimmed =
          [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
      if (trimmed.length < kMinFragmentChars) continue;
      if ([seen containsObject:trimmed]) continue;
      [seen addObject:trimmed];

      NSUInteger available =
          (b.maxTotalChars > *b.totalCharsSoFar) ? (b.maxTotalChars - *b.totalCharsSoFar) : 0;
      if (available == 0) {
        h.budgetHit = true;
        break;
      }
      NSString* toAdd = trimmed;
      bool hitCap = false;
      if (trimmed.length > available) {
        toAdd = [trimmed substringToIndex:available];
        hitCap = true;
      }
      [h.fragments addObject:toAdd];
      h.chars += toAdd.length;
      *b.totalCharsSoFar += toAdd.length;
      if (hitCap || *b.totalCharsSoFar >= b.maxTotalChars) {
        h.budgetHit = true;
        break;
      }
    }
  }

  if (h.budgetHit) return;  // capped mid-node: don't bother descending into children

  CFTypeRef kids = NULL;
  if (AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &kids) == kAXErrorSuccess && kids) {
    if (CFGetTypeID(kids) == CFArrayGetTypeID()) {
      CFArrayRef arr = (CFArrayRef)kids;
      CFIndex count = CFArrayGetCount(arr);
      for (CFIndex i = 0; i < count; i++) {
        collectSubtree((AXUIElementRef)CFArrayGetValueAtIndex(arr, i), depth + 1, h, b, seen);
      }
    }
    CFRelease(kids);
  }
}

#pragma mark - WebKit text marker safety net

// Returns the flat string of `el`'s text-marker range, truncated to
// `maxChars`, or nil when the element does not expose text markers
// (non-WebKit apps) or any step fails. The probe is AXStartTextMarker: if it
// does not answer, nothing else is attempted.
static NSString* textMarkerString(AXUIElementRef el, NSUInteger maxChars) {
  if (!el) return nil;
  NSString* result = nil;

  CFTypeRef start = NULL;
  if (AXUIElementCopyAttributeValue(el, CFSTR("AXStartTextMarker"), &start) == kAXErrorSuccess &&
      start) {
    CFTypeRef end = NULL;
    if (AXUIElementCopyAttributeValue(el, CFSTR("AXEndTextMarker"), &end) == kAXErrorSuccess &&
        end) {
      const void* markers[2] = {start, end};
      CFArrayRef pair = CFArrayCreate(NULL, markers, 2, &kCFTypeArrayCallBacks);
      CFTypeRef range = NULL;
      if (AXUIElementCopyParameterizedAttributeValue(
              el, CFSTR("AXTextMarkerRangeForUnorderedTextMarkers"), pair, &range) ==
              kAXErrorSuccess &&
          range) {
        CFTypeRef str = NULL;
        if (AXUIElementCopyParameterizedAttributeValue(
                el, CFSTR("AXStringForTextMarkerRange"), range, &str) == kAXErrorSuccess &&
            str) {
          if (CFGetTypeID(str) == CFStringGetTypeID()) {
            NSString* full = (__bridge NSString*)str;
            result = full.length <= maxChars ? [full copy] : [full substringToIndex:maxChars];
          }
          CFRelease(str);
        }
        CFRelease(range);
      }
      CFRelease(pair);
      CFRelease(end);
    }
    CFRelease(start);
  }
  return result;
}

#pragma mark - readContextUnderCursor

struct LevelInfo {
  int depth;
  NSUInteger chars;
  NSMutableArray<NSString*>* fragments;
  bool truncated;
};

static Napi::Value ReadContextUnderCursor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  double t0 = nowMs();

  // ---- 1. Options, with defaults for anything the caller omits ----------
  NSUInteger maxDepth = kDefaultMaxDepth;
  NSUInteger maxTotalChars = kDefaultMaxTotalChars;
  double timeBudgetMs = kDefaultTimeBudgetMs;
  double jumpRatio = kDefaultJumpRatio;
  NSUInteger jumpMinChars = kDefaultJumpMinChars;
  NSString* filterMode = nil;
  NSMutableSet<NSString*>* filterBundleIds = nil;

  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("maxDepth") && opts.Get("maxDepth").IsNumber()) {
      maxDepth = (NSUInteger)opts.Get("maxDepth").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("maxTotalChars") && opts.Get("maxTotalChars").IsNumber()) {
      maxTotalChars = (NSUInteger)opts.Get("maxTotalChars").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("timeBudgetMs") && opts.Get("timeBudgetMs").IsNumber()) {
      timeBudgetMs = opts.Get("timeBudgetMs").As<Napi::Number>().DoubleValue();
    }
    if (opts.Has("jumpRatio") && opts.Get("jumpRatio").IsNumber()) {
      jumpRatio = opts.Get("jumpRatio").As<Napi::Number>().DoubleValue();
    }
    if (opts.Has("jumpMinChars") && opts.Get("jumpMinChars").IsNumber()) {
      jumpMinChars = (NSUInteger)opts.Get("jumpMinChars").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("bundleIdFilter") && opts.Get("bundleIdFilter").IsObject()) {
      Napi::Object filter = opts.Get("bundleIdFilter").As<Napi::Object>();
      if (filter.Has("mode") && filter.Get("mode").IsString()) {
        filterMode = [NSString
            stringWithUTF8String:filter.Get("mode").As<Napi::String>().Utf8Value().c_str()];
      }
      if (filter.Has("bundleIds") && filter.Get("bundleIds").IsArray()) {
        Napi::Array arr = filter.Get("bundleIds").As<Napi::Array>();
        filterBundleIds = [NSMutableSet setWithCapacity:arr.Length()];
        for (uint32_t i = 0; i < arr.Length(); i++) {
          Napi::Value v = arr.Get(i);
          if (v.IsString()) {
            [filterBundleIds
                addObject:[NSString stringWithUTF8String:v.As<Napi::String>().Utf8Value().c_str()]];
          }
        }
      }
    }
  }
  double deadlineMs = t0 + timeBudgetMs;

  // ---- Result state, filled progressively. Every early exit below still
  // falls through to the single result-building block at the end, so the
  // JS side always gets a complete NativeContextResult. ---------------------
  bool ok = true;
  std::string reason;
  pid_t pid = -1;
  NSString* bundleId = @"";
  AXError axManualAccessibility = (AXError)-1;  // sentinel: step 5 was never reached
  bool editableFound = false;
  bool editableIsFocused = false;
  std::vector<LevelInfo> levels;
  int chosenLevel = -1;
  NSString* webkitMarkerText = nil;
  double elementAtPositionMs = 0;
  double collectMs = 0;

  // ---- 2. Element at the cursor -------------------------------------------
  AXUIElementRef sysWide = AXUIElementCreateSystemWide();
  AXUIElementSetMessagingTimeout(sysWide, kSystemWideTimeoutSec);
  CGPoint p;
  bool haveCursor = cursorPointAX(&p);
  AXUIElementRef el = NULL;
  AXError posErr = kAXErrorFailure;
  if (haveCursor) {
    posErr = AXUIElementCopyElementAtPosition(sysWide, (float)p.x, (float)p.y, &el);
  }
  elementAtPositionMs = nowMs() - t0;

  if (!haveCursor || posErr != kAXErrorSuccess || !el) {
    ok = false;
    reason = "no-element";
  } else {
    // ---- 3. pid + bundle id (the only things read before the app filter) --
    // A pid we can't resolve means an app we can't identify — fail closed
    // (treated the same as app-not-allowed) rather than falling through with
    // bundleId "" and an empty allowlist/blocklist making the decision by
    // accident.
    bool pidOk = (AXUIElementGetPid(el, &pid) == kAXErrorSuccess);
    NSRunningApplication* app =
        pidOk ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
    bundleId = app.bundleIdentifier ?: @"";

    // ---- 4. App filter, before any harvest of the tree (privacy) ----------
    // Fails closed: an unresolved pid, or a filter mode that isn't exactly
    // "allowlist"/"blocklist" (typo, future value, empty string), denies
    // collection instead of silently letting it through.
    bool allowed = pidOk;
    if (allowed && filterMode) {
      bool inList = filterBundleIds && [filterBundleIds containsObject:bundleId];
      if ([filterMode isEqualToString:@"allowlist"]) {
        allowed = inList;
      } else if ([filterMode isEqualToString:@"blocklist"]) {
        allowed = !inList;
      } else {
        allowed = false;
      }
    }

    if (!allowed) {
      ok = false;
      reason = "app-not-allowed";
    } else {
      // ---- 5. AXManualAccessibility ---------------------------------------
      AXUIElementRef appEl = AXUIElementCreateApplication(pid);
      AXUIElementSetMessagingTimeout(appEl, kElementTimeoutSec);
      axManualAccessibility =
          AXUIElementSetAttributeValue(appEl, CFSTR("AXManualAccessibility"), kCFBooleanTrue);

      // ---- 6. Editable field, with focused-element fallback ---------------
      AXUIElementRef editable = copyElementAttr(el, CFSTR("AXEditableAncestor"));
      if (editable) {
        AXUIElementRef focused = copyElementAttr(appEl, kAXFocusedUIElementAttribute);
        if (focused) {
          editableIsFocused = CFEqual(editable, focused);
          CFRelease(focused);
        }
      } else {
        editable = copyElementAttr(appEl, kAXFocusedUIElementAttribute);
        editableIsFocused = (editable != NULL);  // fallback: true by definition
      }

      if (!editable) {
        ok = false;
        reason = "no-editable";
      } else {
        editableFound = true;
        AXUIElementSetMessagingTimeout(editable, kElementTimeoutSec);

        // ---- 7. Climb one ancestor at a time, watching for the jump -------
        NSUInteger totalCharsSoFar = 0;  // shared across every level of this climb
        Budget budget = {maxTotalChars, deadlineMs, &totalCharsSoFar};
        bool budgetExceeded = false;

        NSMutableSet<NSString*>* seen0 = [NSMutableSet set];
        Harvest h0;
        h0.fragments = [NSMutableArray array];
        h0.chars = 0;
        h0.nodes = 0;
        h0.budgetHit = false;
        h0.truncated = false;
        double cs0 = nowMs();
        collectSubtree(editable, 0, h0, budget, seen0);
        collectMs += nowMs() - cs0;
        levels.push_back({0, h0.chars, h0.fragments, h0.truncated});
        if (h0.budgetHit) budgetExceeded = true;

        AXUIElementRef current = editable;  // borrowed; owned by `editable` below
        bool currentIsEditable = true;
        double prevChars = (double)h0.chars;
        AXUIElementRef chosenAncestor = NULL;

        for (NSUInteger depth = 1; !budgetExceeded && depth <= maxDepth; depth++) {
          AXUIElementRef parent = copyElementAttr(current, kAXParentAttribute);
          if (!parent) break;
          AXUIElementSetMessagingTimeout(parent, kElementTimeoutSec);

          if (!currentIsEditable) CFRelease(current);  // release previous ancestor on climb
          current = parent;
          currentIsEditable = false;

          NSMutableSet<NSString*>* seen = [NSMutableSet set];  // fresh per level, like the spike
          Harvest h;
          h.fragments = [NSMutableArray array];
          h.chars = 0;
          h.nodes = 0;
          h.budgetHit = false;
          h.truncated = false;
          double cs = nowMs();
          collectSubtree(current, 0, h, budget, seen);
          collectMs += nowMs() - cs;
          levels.push_back({(int)depth, h.chars, h.fragments, h.truncated});

          if (h.budgetHit) {
            budgetExceeded = true;
            break;
          }

          double minRequired = jumpRatio * (prevChars > 1.0 ? prevChars : 1.0);
          if (h.chars >= jumpMinChars && (double)h.chars >= minRequired) {
            chosenLevel = (int)depth;
            chosenAncestor = current;  // do not climb past the jump (privacy)
            break;
          }
          prevChars = (double)h.chars;
        }

        if (budgetExceeded) {
          ok = false;
          reason = "budget-exceeded";
        } else {
          // ---- 8. No text collected at all ---------------------------------
          bool anyText = false;
          for (auto& lv : levels) {
            if (lv.chars > 0) {
              anyText = true;
              break;
            }
          }
          if (!anyText) {
            ok = false;
            reason = "no-text";
          } else if (chosenLevel >= 0) {
            // ---- 9. WebKit text-marker safety net, chosen ancestor first --
            webkitMarkerText = textMarkerString(chosenAncestor, maxTotalChars);
            if (webkitMarkerText.length == 0) {
              webkitMarkerText = textMarkerString(editable, maxTotalChars);
            }
          }
        }

        if (!currentIsEditable) CFRelease(current);  // release the last-climbed ancestor
        CFRelease(editable);
      }
      CFRelease(appEl);
    }
  }

  if (el) CFRelease(el);
  CFRelease(sysWide);

  double totalMs = nowMs() - t0;

  // ---- 10/11. Build the result -------------------------------------------
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok) result.Set("reason", Napi::String::New(env, reason));
  result.Set("pid", Napi::Number::New(env, (double)pid));
  result.Set("bundleId", Napi::String::New(env, bundleId.UTF8String ?: ""));
  result.Set("editableFound", Napi::Boolean::New(env, editableFound));
  result.Set("editableIsFocused", Napi::Boolean::New(env, editableIsFocused));
  if (axManualAccessibility != -1) {
    result.Set("axManualAccessibility", Napi::Number::New(env, (double)axManualAccessibility));
  }

  Napi::Array levelsArr = Napi::Array::New(env, levels.size());
  for (size_t i = 0; i < levels.size(); i++) {
    Napi::Object lvl = Napi::Object::New(env);
    lvl.Set("depth", Napi::Number::New(env, levels[i].depth));
    lvl.Set("chars", Napi::Number::New(env, (double)levels[i].chars));
    Napi::Array frags = Napi::Array::New(env, levels[i].fragments.count);
    uint32_t fi = 0;
    for (NSString* f in levels[i].fragments) {
      frags.Set(fi++, Napi::String::New(env, f.UTF8String ?: ""));
    }
    lvl.Set("fragments", frags);
    lvl.Set("truncated", Napi::Boolean::New(env, levels[i].truncated));
    levelsArr.Set((uint32_t)i, lvl);
  }
  result.Set("levels", levelsArr);
  result.Set("chosenLevel", Napi::Number::New(env, chosenLevel));
  if (webkitMarkerText.length > 0) {
    result.Set("webkitMarkerText", Napi::String::New(env, webkitMarkerText.UTF8String ?: ""));
  }

  Napi::Object timings = Napi::Object::New(env);
  timings.Set("elementAtPositionMs", Napi::Number::New(env, elementAtPositionMs));
  timings.Set("collectMs", Napi::Number::New(env, collectMs));
  timings.Set("totalMs", Napi::Number::New(env, totalMs));
  result.Set("timings", timings);

  return result;
}

#pragma mark - activateApp / frontmostPid / isTrusted

static Napi::Value ActivateApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    return Napi::Boolean::New(env, false);
  }
  pid_t pid = (pid_t)info[0].As<Napi::Number>().Int32Value();
  NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!app) return Napi::Boolean::New(env, false);

  // NSApplicationActivateIgnoringOtherApps is deprecated since macOS 14; its
  // replacement (-activate) requires the target app's cooperation, which we
  // don't have here (we're activating an arbitrary foreign app on demand).
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  BOOL activated = [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
#pragma clang diagnostic pop
  return Napi::Boolean::New(env, activated);
}

static Napi::Value FrontmostPid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
  return Napi::Number::New(env, front ? (double)front.processIdentifier : -1);
}

static Napi::Value IsTrusted(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::Boolean::New(env, AXIsProcessTrusted());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("readContextUnderCursor", Napi::Function::New(env, ReadContextUnderCursor));
  exports.Set("activateApp", Napi::Function::New(env, ActivateApp));
  exports.Set("frontmostPid", Napi::Function::New(env, FrontmostPid));
  exports.Set("isTrusted", Napi::Function::New(env, IsTrusted));
  return exports;
}

NODE_API_MODULE(ax_context, Init)
