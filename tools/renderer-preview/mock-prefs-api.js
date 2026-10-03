// Fake window.openFlowPrefs for browser previews.
// Query: ?theme=light|dark &tab=general|dictation|models|advanced
//        &scenario=fresh|installed|restart-pending|downloading
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  if (q.get("tab")) location.hash = "#" + q.get("tab");
  const scenario = q.get("scenario") || "installed";
  // The preview never has a remembered tab: the query string decides.
  try { localStorage.removeItem("openflow.settings.tab"); } catch (e) { /* ignore */ }

  const boot = {
    whisperModelId: "whisper-small", llmModelId: scenario === "restart-pending" ? "qwen-0.5b" : "qwen-1.5b",
    useLlmCleanup: true,
  };
  let prefs = {
    setupComplete: true, whisperModelId: "whisper-small", llmModelId: "qwen-1.5b",
    hotkeyAccelerator: "Hold Option", language: scenario === "fresh" ? "auto" : "it", debugLogging: false,
    useLlmCleanup: true, launchAtLogin: true, spokenPunctuation: false,
    dictionary: scenario === "fresh" ? [] : ["Kubernetes", "open-flow", "Qwen"],
  };
  const full = scenario === "installed" || scenario === "restart-pending";
  const LICENSE = "The 3B cleanup model is licensed for non-commercial use only.";
  const whisper = [
    { id: "whisper-small", label: "Whisper Small", description: "Fast. Good for English and Italian.", sizeBytes: 487601967, ramBytes: 1e9, installed: true, licenseNote: null },
    { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", description: "Most accurate. Slower on 8 GB Macs.", sizeBytes: 1624555275, ramBytes: 2.5e9, installed: full, licenseNote: null },
  ];
  const llm = [
    { id: "qwen-0.5b", label: "Qwen 2.5 0.5B", description: "Lightest cleanup. May over-edit.", sizeBytes: 491400032, ramBytes: 7e8, installed: full, licenseNote: null },
    { id: "qwen-1.5b", label: "Qwen 2.5 1.5B", description: "Recommended balance of speed and quality.", sizeBytes: 1117320736, ramBytes: 1.4e9, installed: true, licenseNote: null },
    { id: "qwen-3b", label: "Qwen 2.5 3B", description: "Best cleanup. Needs 16 GB of RAM to stay snappy.", sizeBytes: 2104932768, ramBytes: 2.6e9, installed: scenario === "installed", licenseNote: LICENSE },
  ];
  const languages = [
    { id: "auto", label: "Auto-detect" }, { id: "en", label: "English" }, { id: "it", label: "Italiano" },
    { id: "es", label: "Español" }, { id: "fr", label: "Français" }, { id: "de", label: "Deutsch" },
  ];
  const progressCbs = [];
  const timers = {};
  const find = (id) => whisper.concat(llm).find((x) => x.id === id);

  window.openFlowPrefs = {
    load: () => Promise.resolve({ ...prefs }),
    update: (patch) => { prefs = { ...prefs, ...patch }; console.log("[mock] update", patch); return Promise.resolve({ ...prefs }); },
    restartStatus: () => Promise.resolve({
      fields: ["whisperModelId", "llmModelId", "useLlmCleanup"].filter((k) => prefs[k] !== boot[k]),
    }),
    listModels: () => Promise.resolve({
      whisper: whisper.map((m) => ({ ...m })), llm: llm.map((m) => ({ ...m })), languages,
    }),
    downloadModel: (kind, id) => new Promise((resolve, reject) => {
      const m = find(id);
      let bytes = 0;
      const stallAt = scenario === "downloading" ? m.sizeBytes * 0.4 : Infinity;
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
    appInfo: () => Promise.resolve({ version: "0.2.3" }),
    onShowTab: () => () => undefined,
  };

  // Scenario "downloading": start the Whisper Large download as soon as its button exists.
  if (scenario === "downloading") {
    const poll = setInterval(() => {
      const btn = [...document.querySelectorAll('.model-card[data-id="whisper-large-v3-turbo"] button')].find((b) => b.textContent === "Download");
      if (btn) { clearInterval(poll); btn.click(); }
    }, 50);
  }
})();
