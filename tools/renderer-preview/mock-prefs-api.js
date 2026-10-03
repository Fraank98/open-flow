// Fake window.openFlowPrefs for browser previews.
// Query: ?theme=light|dark &tab=general|dictation|models|reply|advanced
//        &scenario=fresh|installed|restart-pending|downloading|reopened (window reopened mid-download)
//        Reply tab: reply-off (requirements missing) | reply-on (model ready, shortcut active)
//                   | reply-downloading (Standard model downloading) | reply-bad-shortcut (refused combination)
//                   | reply-failed (server failed)
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  if (q.get("tab")) location.hash = "#" + q.get("tab");
  const scenario = q.get("scenario") || "installed";
  const isReply = scenario.indexOf("reply-") === 0;
  // The reply scenarios share the "installed" data of the other tabs.
  const base = isReply ? "installed" : scenario;
  // The preview never has a remembered tab: the query string decides.
  try { localStorage.removeItem("openflow.settings.tab"); } catch (e) { /* ignore */ }

  const boot = {
    whisperModelId: "whisper-small", llmModelId: base === "restart-pending" ? "qwen-0.5b" : "qwen-1.5b",
    useLlmCleanup: true,
  };
  let prefs = {
    setupComplete: true, whisperModelId: "whisper-small", llmModelId: "qwen-1.5b",
    hotkeyAccelerator: "Hold Option", language: base === "fresh" ? "auto" : "it", debugLogging: false,
    useLlmCleanup: true, launchAtLogin: true, spokenPunctuation: false,
    dictionary: base === "fresh" ? [] : ["Kubernetes", "open-flow", "Qwen"],
    replySuggestionsEnabled: scenario === "reply-on" || scenario === "reply-bad-shortcut" || scenario === "reply-failed",
    userDisplayName: scenario === "reply-off" ? "" : "Danilo Franco",
    replySuggestionsHotkey: "Command+Control+R",
    replyModelId: "gemma-3-4b",
    replyAppsMode: "allowlist",
    replyApps: ["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"],
  };
  const full = base === "installed" || base === "restart-pending";
  const LICENSE = "The 3B cleanup model is licensed for non-commercial use only.";
  const whisper = [
    { id: "whisper-small", label: "Whisper Small", description: "Fast. Good for English and Italian.", sizeBytes: 487601967, ramBytes: 1e9, installed: true, licenseNote: null },
    { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", description: "Most accurate. Slower on 8 GB Macs.", sizeBytes: 1624555275, ramBytes: 2.5e9, installed: full, licenseNote: null },
  ];
  const llm = [
    { id: "qwen-0.5b", label: "Qwen 2.5 0.5B", description: "Lightest cleanup. May over-edit.", sizeBytes: 491400032, ramBytes: 7e8, installed: full, licenseNote: null },
    { id: "qwen-1.5b", label: "Qwen 2.5 1.5B", description: "Recommended balance of speed and quality.", sizeBytes: 1117320736, ramBytes: 1.4e9, installed: true, licenseNote: null },
    { id: "qwen-3b", label: "Qwen 2.5 3B", description: "Best cleanup. Needs 16 GB of RAM to stay snappy.", sizeBytes: 2104932768, ramBytes: 2.6e9, installed: base === "installed", licenseNote: LICENSE },
  ];
  const BENCH_STD = "In the benchmark of the classifier alone, Gemma 3 4B misread 4 of 8 questions that were really asking for something only you know (for example \"how often do you go to the gym?\"). With the deterministic pre-gate that runs before the classifier (active in this build) that drops to 1 of 8. Still check a proposal before you accept it.";
  const BENCH_MAX = "In the benchmark, Gemma 4 E4B never mistook a question asking for a fact for one that needs a decision (0 false positives out of 8). It is slower (about 900 ms) and in 3 cases out of 12 it did not offer a reply that would have been appropriate. Recommended from 24 GB of RAM.";
  const reply = [
    { id: "gemma-3-4b", tierId: "default", label: "Standard", description: "Gemma 3 4B. Faster, a good fit for most Macs.", sizeBytes: 2489894016, ramBytes: 3.1e9, installed: scenario === "reply-on" || scenario === "reply-bad-shortcut" || scenario === "reply-failed", licenseNote: null, details: BENCH_STD },
    { id: "gemma-4-e4b", tierId: "max", label: "Maximum quality", description: "Gemma 4 E4B. Slower, best with 24 GB of RAM or more.", sizeBytes: 4977171584, ramBytes: 5.8e9, installed: false, licenseNote: null, details: BENCH_MAX },
  ];
  // A flat colour square stands in for the app icon the main process would send.
  const icon = (c) => "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="' + c + '"/></svg>');
  const APPS = {
    "com.tinyspeck.slackmacgap": { name: "Slack", icon: icon("#4a154b") },
    "com.apple.mail": { name: "Mail", icon: icon("#2f7cf6") },
    "com.brave.Browser": { name: "Brave Browser", icon: icon("#fb542b") },
    "com.apple.Safari": { name: "Safari", icon: icon("#1b9cf2") },
  };
  const languages = [
    { id: "auto", label: "Auto-detect" }, { id: "en", label: "English" }, { id: "it", label: "Italiano" },
    { id: "es", label: "Español" }, { id: "fr", label: "Français" }, { id: "de", label: "Deutsch" },
  ];
  const progressCbs = [];
  const timers = {};
  const find = (id) => whisper.concat(llm, reply).find((x) => x.id === id);
  const MODS = ["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "shift", "super", "meta"];
  // Mirrors validateReplyAccelerator (src/main/utils/reply-hotkey.ts) for the preview.
  function validate(acc) {
    const parts = acc.split("+").map((x) => x.trim().toLowerCase());
    if (parts.some((x) => !x)) return { ok: false, reason: "no-key" };
    if (parts.some((x) => ["alt", "option", "altgr"].indexOf(x) !== -1)) return { ok: false, reason: "contains-option" };
    const keys = parts.filter((x) => MODS.indexOf(x) === -1);
    if (keys.length !== 1) return { ok: false, reason: "no-key" };
    if (parts.length === 1) return { ok: false, reason: "no-modifier" };
    if (!parts.some((x) => MODS.indexOf(x) !== -1 && x !== "shift")) return { ok: false, reason: "shift-only" };
    if (["1", "2", "3", "escape", "esc"].indexOf(keys[0]) !== -1) return { ok: false, reason: "reserved-key" };
    const mods = parts.filter((x) => MODS.indexOf(x) !== -1);
    if (mods.length === 1 && ["command", "cmd", "commandorcontrol", "cmdorctrl", "super", "meta"].indexOf(mods[0]) !== -1 && ["q", "w", "h", "m", "tab", "space", ",", "`"].indexOf(keys[0]) !== -1) return { ok: false, reason: "system-reserved" };
    return { ok: true, accelerator: acc };
  }

  window.openFlowPrefs = {
    load: () => Promise.resolve({ ...prefs }),
    update: (patch) => { prefs = { ...prefs, ...patch }; console.log("[mock] update", patch); return Promise.resolve({ ...prefs }); },
    restartStatus: () => Promise.resolve({
      fields: ["whisperModelId", "llmModelId", "useLlmCleanup"].filter((k) => prefs[k] !== boot[k]),
    }),
    // Like the real API: `downloading` + last `progress` for a download that is in flight.
    listModels: () => Promise.resolve({
      whisper: whisper.map((m) => (
        scenario === "reopened" && m.id === "whisper-large-v3-turbo"
          ? { ...m, downloading: true, progress: { bytes: m.sizeBytes * 0.4, total: m.sizeBytes } }
          : { ...m, downloading: false, progress: null }
      )),
      llm: llm.map((m) => ({ ...m, downloading: false, progress: null })),
      reply: reply.map((m) => ({ ...m, downloading: false, progress: null })),
      languages,
    }),
    downloadModel: (kind, id) => new Promise((resolve, reject) => {
      const m = find(id);
      // Re-attaching to a download that never ends in the preview: stay pending.
      if (scenario === "reopened") { timers[id] = { reject, t: 0 }; return; }
      let bytes = 0;
      const stallAt = scenario === "downloading" || scenario === "reply-downloading" ? m.sizeBytes * 0.4 : Infinity;
      timers[id] = { reject, t: setInterval(() => {
        bytes = Math.min(bytes + m.sizeBytes / 10, stallAt);
        progressCbs.forEach((cb) => cb({ id, bytes, total: m.sizeBytes }));
        if (bytes >= m.sizeBytes) { clearInterval(timers[id].t); m.installed = true; resolve(); }
      }, 300) };
    }),
    cancelDownload: (id) => {
      const t = timers[id];
      if (t) { clearInterval(t.t); t.reject(new Error("Error invoking remote method 'prefs:download-model': Error: Download paused")); }
    },
    deleteModel: (kind, id) => {
      const m = find(id);
      if (m) m.installed = false;
      return Promise.resolve();
    },
    relaunch: () => console.log("[mock] relaunch"),
    onDownloadProgress: (cb) => { progressCbs.push(cb); return () => progressCbs.splice(progressCbs.indexOf(cb), 1); },
    permissionsStatus: (opts) => Promise.resolve(
      scenario === "fresh"
        ? { mic: "granted", accessibility: "denied", automation: opts && opts.automation ? "denied" : "unknown" }
        : { mic: "granted", accessibility: "granted", automation: "granted" },
    ),
    openSystemSettings: (pane) => console.log("[mock] open System Settings", pane),
    openLogs: () => console.log("[mock] open logs"),
    revealModels: () => console.log("[mock] reveal models"),
    openProjectPage: () => console.log("[mock] open project page"),
    resetSetup: () => { console.log("[mock] reset setup"); return Promise.resolve(false); },
    appInfo: () => Promise.resolve({ version: "0.3.0" }),
    onShowTab: () => () => undefined,
    replyStatus: () => Promise.resolve({
      serverState: scenario === "reply-on" || scenario === "reply-bad-shortcut" ? "ready" : scenario === "reply-failed" ? "failed" : "off",
      serverError: scenario === "reply-failed" ? "llama-server exited (code 1)" : null,
      hotkeyRegistered: scenario !== "reply-booting", nativeOk: scenario !== "reply-booting", booting: scenario === "reply-booting",
      lastBlockedBundleId: scenario === "reply-on" ? "com.apple.Safari" : null,
    }),
    validateReplyHotkey: (acc) => Promise.resolve(validate(acc)),
    retryReply: () => Promise.resolve(),
    recorderActive: () => {},
    onReservedKey: () => () => {},
    pickApp: () => Promise.resolve({ bundleId: "com.apple.Safari", name: "Safari", icon: APPS["com.apple.Safari"].icon }),
    resolveApps: (ids) => Promise.resolve(ids.map((id) => ({ bundleId: id, name: APPS[id] ? APPS[id].name : null, icon: APPS[id] ? APPS[id].icon : null }))),
  };

  // Scenario "downloading": start the Whisper Large download as soon as its button exists.
  if (scenario === "downloading") {
    const poll = setInterval(() => {
      const btn = [...document.querySelectorAll('.model-card[data-id="whisper-large-v3-turbo"] button')].find((b) => b.textContent === "Download");
      if (btn) { clearInterval(poll); btn.click(); }
    }, 50);
  }

  // Scenario "reply-downloading": start the Standard download as soon as its button exists.
  if (scenario === "reply-downloading") {
    const poll = setInterval(() => {
      const btn = [...document.querySelectorAll('.model-card[data-id="gemma-3-4b"] button')].find((b) => b.textContent === "Download");
      if (btn) { clearInterval(poll); btn.click(); }
    }, 50);
  }

  // Scenario "reply-bad-shortcut": press Command+Option+R in the recorder, which Option makes invalid.
  if (scenario === "reply-bad-shortcut") {
    const poll = setInterval(() => {
      const field = document.getElementById("replyHotkey");
      if (!field || !field.value) return;
      clearInterval(poll);
      field.focus();
      field.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", key: "®", metaKey: true, altKey: true, bubbles: true, cancelable: true }));
    }, 80);
  }
})();
