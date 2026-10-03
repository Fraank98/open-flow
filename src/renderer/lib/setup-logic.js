// Pure helpers for the setup wizard. Loaded as a plain script in the browser
// (globalThis.OpenFlowSetupLogic) and imported for its side effect in vitest.
(function (root, factory) { root.OpenFlowSetupLogic = factory(); })(globalThis, function () {
  "use strict";

  /** Badge text and css class for a permission status. */
  function permissionBadge(status) {
    if (status === "granted") return { text: "Granted", cls: "granted" };
    if (status === "denied") return { text: "Denied — fix in System Settings", cls: "denied" };
    return { text: "Not asked yet", cls: "pending" };
  }

  /** Continue is enabled only when microphone, Accessibility and Automation are all granted. */
  function canContinuePermissions(state) {
    return (
      !!state &&
      state.micPermission === "granted" &&
      state.accessibilityPermission === "granted" &&
      state.automationPermission === "granted"
    );
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

  var STATS_WINDOW_MS = 5000;

  /**
   * Speed and ETA from progress samples `{ t (ms), bytes }`, over a sliding
   * 5 s window ending at the last sample. No ETA until two samples show progress.
   */
  function downloadStats(samples, total) {
    if (!samples || samples.length < 2) return { bytesPerSec: 0, etaSec: null };
    var last = samples[samples.length - 1];
    var win = samples.filter(function (s) { return s.t >= last.t - STATS_WINDOW_MS; });
    if (win.length < 2) win = samples.slice(-2);
    var first = win[0];
    var dt = (last.t - first.t) / 1000;
    var db = last.bytes - first.bytes;
    if (dt <= 0 || db <= 0) return { bytesPerSec: 0, etaSec: null };
    var bytesPerSec = db / dt;
    var remaining = Math.max(0, total - last.bytes);
    return { bytesPerSec: bytesPerSec, etaSec: remaining / bytesPerSec };
  }

  /** "20 s left" / "about 2 min left"; empty when unknown. */
  function formatEta(sec) {
    if (sec == null || !isFinite(sec)) return "";
    if (sec < 60) return Math.max(1, Math.round(sec)) + " s left";
    var min = Math.round(sec / 60);
    if (min < 90) return "about " + min + " min left";
    return "about " + (Math.round(sec / 360) / 10) + " h left";
  }

  /** Whole minutes (rounded up, at least 1) to download `bytes` at `bytesPerSec`. */
  function estimateMinutes(bytes, bytesPerSec) {
    return Math.max(1, Math.ceil(bytes / bytesPerSec / 60));
  }

  var STEP_ORDER = ["welcome", "permissions", "tier", "download", "ready"];
  var ASSUMED_BYTES_PER_SEC = 100e6 / 8; // 100 Mbps, for the tier estimate

  /**
   * Where an interrupted setup restarts: the saved step, but never beyond
   * "download" (the window cannot show a finished setup it did not run), and
   * back at "tier" when no quality level was ever chosen.
   */
  function resumeStep(prefs) {
    var step = prefs && prefs.setupStep;
    if (STEP_ORDER.indexOf(step) === -1) return "welcome";
    if (step === "ready") step = "download";
    if (step === "download" && !prefs.setupTierId) return "tier";
    return step;
  }

  /** Text lines of a tier card: summary, size/RAM/time, transcription note, license note (if any). */
  function tierCardLines(tier) {
    var lines = [
      tier.summary,
      formatBytes(tier.sizeBytes) + " download · ~" + formatBytes(tier.ramBytes) +
        " of RAM while running · about " + estimateMinutes(tier.sizeBytes, ASSUMED_BYTES_PER_SEC) +
        " min on a 100 Mbps connection",
      tier.transcriptionNote,
    ];
    if (tier.licenseNote) lines.push(tier.licenseNote);
    return lines;
  }

  /** "Free space on this Mac: 42.0 GB", flagged when the tier (not yet on disk) would not fit. */
  function freeSpaceInfo(freeBytes, tier) {
    if (freeBytes == null) return null;
    var low = !!tier && !tier.installed && freeBytes < tier.sizeBytes * 1.05;
    return { text: "Free space on this Mac: " + formatBytes(freeBytes), low: low };
  }

  var READY_TEXT = {
    recording: "Listening…",
    transcribing: "Transcribing…",
    cleaning: "Cleaning up…",
    pasting: "Pasting…",
    pasted: "Pasted — nice.",
  };

  /** Live line of the final step; `pasted` is the view state after a successful paste. */
  function readyStepText(state) {
    return READY_TEXT[state] || "Waiting for you…";
  }

  /** The view state for a pipeline transition: pasting -> idle means the text landed. */
  function pipelineView(prev, next) {
    return prev === "pasting" && next === "idle" ? "pasted" : next;
  }

  return {
    readyStepText: readyStepText,
    pipelineView: pipelineView,
    permissionBadge: permissionBadge,
    canContinuePermissions: canContinuePermissions,
    formatBytes: formatBytes,
    downloadStats: downloadStats,
    formatEta: formatEta,
    estimateMinutes: estimateMinutes,
    resumeStep: resumeStep,
    tierCardLines: tierCardLines,
    freeSpaceInfo: freeSpaceInfo,
  };
});
