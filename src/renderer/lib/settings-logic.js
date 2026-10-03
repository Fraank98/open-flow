// Pure helpers for the Settings window. Loaded as a plain script in the browser
// (globalThis.OpenFlowSettingsLogic) and imported for its side effect in vitest.
(function (root, factory) { root.OpenFlowSettingsLogic = factory(); })(globalThis, function () {
  "use strict";

  /** "Restart required" when `field` is among the fields pending a restart, else null. */
  function restartBadgeFor(field, restartFields) {
    return Array.isArray(restartFields) && restartFields.indexOf(field) !== -1 ? "Restart required" : null;
  }

  /** The restart banner shows while at least one field is pending. */
  function bannerVisible(restartFields) {
    return Array.isArray(restartFields) && restartFields.length > 0;
  }

  /**
   * What a model card offers. Active = the selected installed model (not
   * deletable); not installed = Download; installed but not selected = Use + Delete.
   * The license note is passed through untouched.
   */
  function modelRowView(model, selectedId) {
    var licenseNote = model.licenseNote == null ? null : model.licenseNote;
    if (!model.installed) return { primaryAction: "download", canDelete: false, licenseNote: licenseNote };
    if (model.id === selectedId) return { primaryAction: "active", canDelete: false, licenseNote: licenseNote };
    return { primaryAction: "use", canDelete: true, licenseNote: licenseNote };
  }

  /**
   * Human-readable size, decimal units. MUST follow exactly the rule of
   * `formatBytes` in src/main/utils/format-bytes.ts (a unit test compares the
   * two): >= 1 GB -> one decimal; below that, MB to two significant digits;
   * a value that would round to "1000 MB" is shown as GB.
   */
  function formatBytes(bytes) {
    var n = Math.max(0, bytes);
    var mb = n / 1000000;
    if (mb >= 100) mb = Math.round(mb / 10) * 10;
    else mb = Math.round(mb);
    if (n >= 1000000000 || mb >= 1000) return (n / 1000000000).toFixed(1) + " GB";
    if (n > 0 && mb === 0) mb = 1;
    return mb + " MB";
  }

  /** "Models on disk: 1.6 GB" — the installed models only. */
  function storageSummary(models) {
    var total = 0;
    (models || []).forEach(function (m) { if (m.installed) total += m.sizeBytes; });
    return "Models on disk: " + formatBytes(total);
  }

  /** "490 MB · ~1.0 GB RAM" */
  function modelMeta(model) {
    return formatBytes(model.sizeBytes) + " · ~" + formatBytes(model.ramBytes) + " RAM";
  }

  /**
   * Tab id from a location hash ("#models" -> "models"). Generic: any id is
   * accepted, so a new tab only needs a button and a panel. Falls back to
   * "general" for an empty/odd hash or, when `available` is given, an unknown id.
   */
  function tabFromHash(hash, available) {
    var id = String(hash || "").replace(/^#/, "");
    if (!/^[a-z][a-z0-9-]*$/i.test(id)) return "general";
    if (available && available.indexOf(id) === -1) return "general";
    return id;
  }

  /**
   * Electron prefixes errors thrown by an IPC handler with
   * "Error invoking remote method '<channel>': Error: ". Strip it before showing.
   */
  function cleanIpcError(message) {
    var text = message && typeof message === "object" && "message" in message ? message.message : message;
    if (typeof text !== "string" || !text) return "Something went wrong.";
    return text.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
  }

  /** Text for a permission row. */
  function permissionRow(status) {
    if (status === "granted") return { text: "Granted", granted: true };
    if (status === "denied") return { text: "Not granted", granted: false };
    return { text: "Not asked yet", granted: false };
  }

  /**
   * The line under the Reply suggestions toggle: what must be done before it can
   * be switched on ("" when nothing). Lives under the toggle, never in a global
   * status line.
   */
  function replyGuardMessage(input) {
    if (!input.nativeOk) {
      return "Reply suggestions are unavailable in this session: the helper that reads conversations didn't load.";
    }
    var missing = [];
    if (String(input.name || "").trim().length === 0) missing.push("enter your name");
    if (!input.modelInstalled) missing.push("download the " + input.tierLabel + " model");
    return missing.length > 0 ? "To turn this on: " + missing.join(" and ") + "." : "";
  }

  /**
   * Label of the app list and, when the list changes what the mode means, a
   * warning. An empty allowlist reads nothing; an empty blocklist reads everything.
   */
  function replyAppsView(mode, appCount) {
    if (mode === "blocklist") {
      return {
        label: "Apps to exclude",
        warning: appCount > 0 ? "Every other app can be read." : "No app excluded: every app can be read.",
      };
    }
    return { label: "Apps to read", warning: appCount > 0 ? null : "No app added: nothing will be read." };
  }

  var MAC_MODIFIERS = { control: "⌃", ctrl: "⌃", shift: "⇧", command: "⌘", cmd: "⌘", commandorcontrol: "⌘", cmdorctrl: "⌘", super: "⌘", meta: "⌘" };
  var MAC_KEYS = { up: "↑", down: "↓", left: "←", right: "→", return: "↩", enter: "↩", tab: "⇥", backspace: "⌫", delete: "⌦", escape: "⎋", esc: "⎋" };

  /** "Command+Control+R" -> "⌃⌘R": modifiers in macOS order (⌃ ⌥ ⇧ ⌘), then the key. */
  function acceleratorLabel(accelerator) {
    var order = ["⌃", "⌥", "⇧", "⌘"];
    var mods = [];
    var key = "";
    String(accelerator || "").split("+").forEach(function (part) {
      var lower = part.trim().toLowerCase();
      if (lower === "alt" || lower === "option") {
        if (mods.indexOf("⌥") === -1) mods.push("⌥");
      } else if (MAC_MODIFIERS[lower]) {
        if (mods.indexOf(MAC_MODIFIERS[lower]) === -1) mods.push(MAC_MODIFIERS[lower]);
      } else {
        key = MAC_KEYS[lower] || (part.trim().length === 1 ? part.trim().toUpperCase() : part.trim());
      }
    });
    mods.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return mods.join("") + key;
  }

  /**
   * The server state as one sentence for the Reply tab. tone drives the colour;
   * action "retry" turns the sentence into a Retry button. Nothing is said while
   * the feature is off or unavailable (the line under the toggle covers those).
   */
  function replyStatusView(status, accelerator) {
    var none = { text: "", tone: "none", action: null };
    if (!status.nativeOk) return none;
    switch (status.serverState) {
      case "ready":
        if (!status.hotkeyRegistered) return { text: "Shortcut taken by another app — choose another", tone: "error", action: null };
        return { text: "Model: ready · " + acceleratorLabel(accelerator) + " active", tone: "ok", action: null };
      case "starting":
        return { text: "Model: loading…", tone: "busy", action: null };
      case "downloading":
        return { text: "Model: downloading…", tone: "busy", action: null };
      case "failed":
        return { text: "Model: failed — Retry", tone: "error", action: "retry" };
      default:
        return none;
    }
  }

  var CODE_KEYS = {
    Space: "Space", Enter: "Return", NumpadEnter: "Return", Backspace: "Backspace", Tab: "Tab", Escape: "Escape",
    Delete: "Delete", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
    BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`",
  };

  /**
   * Builds an Electron accelerator from a keydown ("Command+Control+R"), or null
   * while only modifiers are down / the key is unknown. It reads the physical key
   * (`code`), so Option's dead keys and shifted symbols never leak in. Option is
   * kept as "Alt": the validator then explains why it is refused.
   */
  function acceleratorFromKeyEvent(ev) {
    var code = String(ev.code || "");
    var key = null;
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) key = m[1];
    else if ((m = /^Digit([0-9])$/.exec(code))) key = m[1];
    else if ((m = /^Numpad([0-9])$/.exec(code))) key = m[1];
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
    else if (Object.prototype.hasOwnProperty.call(CODE_KEYS, code)) key = CODE_KEYS[code];
    if (key === null) return null;
    var parts = [];
    if (ev.metaKey) parts.push("Command");
    if (ev.ctrlKey) parts.push("Control");
    if (ev.shiftKey) parts.push("Shift");
    if (ev.altKey) parts.push("Alt");
    parts.push(key);
    return parts.join("+");
  }

  var HOTKEY_REASONS = {
    "contains-option": "Option is used for dictation. Choose another combination.",
    "no-modifier": "Add at least one of Command, Control or Shift.",
    "no-key": "Add a key besides the modifiers.",
    "reserved-key": "1, 2, 3 and Esc are the pill's shortcuts while it is visible.",
  };

  /** Why the validator refused a shortcut, in a sentence. */
  function hotkeyReasonText(reason) {
    return Object.prototype.hasOwnProperty.call(HOTKEY_REASONS, reason) ? HOTKEY_REASONS[reason] : "That shortcut isn't valid.";
  }

  return {
    acceleratorFromKeyEvent: acceleratorFromKeyEvent,
    hotkeyReasonText: hotkeyReasonText,
    acceleratorLabel: acceleratorLabel,
    replyStatusView: replyStatusView,
    replyGuardMessage: replyGuardMessage,
    replyAppsView: replyAppsView,
    restartBadgeFor: restartBadgeFor,
    bannerVisible: bannerVisible,
    modelRowView: modelRowView,
    formatBytes: formatBytes,
    storageSummary: storageSummary,
    modelMeta: modelMeta,
    tabFromHash: tabFromHash,
    cleanIpcError: cleanIpcError,
    permissionRow: permissionRow,
  };
});
