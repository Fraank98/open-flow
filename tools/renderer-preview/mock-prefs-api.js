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
  const whisper = [
    { id: "whisper-small", label: "whisper small", sizeBytes: 487601967, installed: true },
    { id: "whisper-large-v3-turbo", label: "whisper large v3 turbo", sizeBytes: 1624555275, installed: false },
  ];
  const llm = [
    { id: "qwen-0.5b", label: "qwen 0.5b", sizeBytes: 491e6, installed: full },
    { id: "qwen-1.5b", label: "qwen 1.5b", sizeBytes: 1117320736, installed: true },
    { id: "qwen-3b", label: "qwen 3b", sizeBytes: 2104932768, installed: false },
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
