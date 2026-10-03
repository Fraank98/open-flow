// Fake window.openFlowPrefs for browser previews. Query: ?theme=light|dark&scenario=fresh|installed
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  const scenario = q.get("scenario") || "installed";

  let prefs = {
    setupComplete: true, whisperModelId: "whisper-small", llmModelId: "qwen-1.5b",
    hotkeyAccelerator: "Hold Option", language: "auto", debugLogging: false,
    useLlmCleanup: true, launchAtLogin: true, spokenPunctuation: false,
    dictionary: ["Kubernetes", "open-flow"],
  };
  const full = scenario === "installed";
  const LICENSE = "The 3B cleanup model is licensed for non-commercial use only.";
  const whisper = [
    { id: "whisper-small", label: "Whisper Small", description: "Fast. Good for English and Italian.", sizeBytes: 487601967, ramBytes: 1e9, installed: true, licenseNote: null },
    { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", description: "Most accurate. Slower on 8 GB Macs.", sizeBytes: 1624555275, ramBytes: 2.5e9, installed: false, licenseNote: null },
  ];
  const llm = [
    { id: "qwen-0.5b", label: "Qwen 2.5 0.5B", description: "Lightest cleanup. May over-edit.", sizeBytes: 491400032, ramBytes: 7e8, installed: full, licenseNote: null },
    { id: "qwen-1.5b", label: "Qwen 2.5 1.5B", description: "Recommended balance of speed and quality.", sizeBytes: 1117320736, ramBytes: 1.4e9, installed: true, licenseNote: null },
    { id: "qwen-3b", label: "Qwen 2.5 3B", description: "Best cleanup. Needs 16 GB of RAM to stay snappy.", sizeBytes: 2104932768, ramBytes: 2.6e9, installed: false, licenseNote: LICENSE },
  ];
  const languages = [
    { id: "auto", label: "Auto-detect" }, { id: "en", label: "English" }, { id: "it", label: "Italiano" },
  ];
  const progressCbs = [];

  window.openFlowPrefs = {
    load: () => Promise.resolve({ ...prefs }),
    save: (next) => { prefs = { ...next }; console.log("[mock] save", next); return Promise.resolve(next); },
    listModels: () => Promise.resolve({
      whisper: whisper.map((m) => ({ ...m })), llm: llm.map((m) => ({ ...m })), languages,
    }),
    downloadModel: (kind, id) => new Promise((resolve) => {
      const list = kind === "whisper" ? whisper : llm;
      const m = list.find((x) => x.id === id);
      let bytes = 0;
      const t = setInterval(() => {
        bytes += m.sizeBytes / 10;
        progressCbs.forEach((cb) => cb({ id, bytes: Math.min(bytes, m.sizeBytes), total: m.sizeBytes }));
        if (bytes >= m.sizeBytes) { clearInterval(t); m.installed = true; resolve(); }
      }, 300);
    }),
    deleteModel: (kind, id) => {
      const m = (kind === "whisper" ? whisper : llm).find((x) => x.id === id);
      if (m) m.installed = false;
      return Promise.resolve();
    },
    relaunch: () => console.log("[mock] relaunch"),
    onDownloadProgress: (cb) => { progressCbs.push(cb); return () => progressCbs.splice(progressCbs.indexOf(cb), 1); },
  };
})();
