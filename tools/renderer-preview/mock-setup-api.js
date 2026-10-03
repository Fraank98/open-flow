// Fake window.openFlowSetup for browser previews. Query: ?theme=light|dark&scenario=fresh|no-permissions|granted|download-error
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  const scenario = q.get("scenario") || "fresh";

  const LICENSE = "The 3B cleanup model is licensed for non-commercial use only.";
  const tiers = [
    { id: "fast", label: "Fast", description: "Whisper Small + Qwen 0.5B", summary: "Whisper Small + Qwen 0.5B",
      transcriptionNote: "Same transcription as Balanced, lighter cleanup.", recommended: false,
      sizeBytes: 487601967 + 491400032, ramBytes: 1.7e9, installed: false, licenseNote: null },
    { id: "balanced", label: "Balanced", description: "Whisper Small + Qwen 1.5B", summary: "Whisper Small + Qwen 1.5B",
      transcriptionNote: "Recommended for most Macs.", recommended: true,
      sizeBytes: 487601967 + 1117320736, ramBytes: 2.4e9, installed: false, licenseNote: null },
    { id: "max", label: "Maximum quality", description: "Whisper Large v3 Turbo + Qwen 3B", summary: "Whisper Large v3 Turbo + Qwen 3B",
      transcriptionNote: "Best accuracy. Needs 16 GB of RAM.", recommended: false,
      sizeBytes: 1624555275 + 2104932768, ramBytes: 5.1e9, installed: false, licenseNote: LICENSE },
  ];
  const perms = scenario === "granted"
    ? { mic: "granted", acc: "granted" }
    : scenario === "no-permissions"
      ? { mic: "denied", acc: "denied" }
      : { mic: "unknown", acc: "denied" };

  const progressCbs = [];
  const doneCbs = [];
  let timer = null;

  window.openFlowSetup = {
    getInitialState: () => Promise.resolve({
      micPermission: perms.mic, accessibilityPermission: perms.acc, tiers,
    }),
    requestMicPermission: () => { perms.mic = "granted"; return Promise.resolve("granted"); },
    refreshAccessibilityStatus: () => Promise.resolve(perms.acc),
    openAccessibilitySettings: () => { perms.acc = "granted"; },
    openMicSettings: () => { perms.mic = "granted"; },
    startDownload: () => {
      const total = 490e6;
      let bytes = 0;
      clearInterval(timer);
      timer = setInterval(() => {
        bytes += 20e6;
        progressCbs.forEach((cb) => cb({ stage: "Downloading Whisper model", bytes: Math.min(bytes, total), total }));
        if (scenario === "download-error" && bytes >= 200e6) {
          clearInterval(timer);
          doneCbs.forEach((cb) => cb({ ok: false, error: "fetch failed" }));
        } else if (bytes >= total) {
          clearInterval(timer);
          doneCbs.forEach((cb) => cb({ ok: true }));
        }
      }, 250);
      return Promise.resolve();
    },
    onDownloadProgress: (cb) => { progressCbs.push(cb); return () => progressCbs.splice(progressCbs.indexOf(cb), 1); },
    onDownloadDone: (cb) => { doneCbs.push(cb); return () => doneCbs.splice(doneCbs.indexOf(cb), 1); },
    finish: () => console.log("[mock] finish"),
  };
})();
