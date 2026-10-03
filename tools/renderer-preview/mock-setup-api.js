// Fake window.openFlowSetup for browser previews. Query: ?theme=light|dark&scenario=fresh|no-permissions|granted|download-error
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  const scenario = q.get("scenario") || "fresh";

  const tiers = [
    { id: "fast", label: "Fast", description: "Whisper Small + Qwen 0.5B. Lightest, ~1 GB download." },
    { id: "balanced", label: "Balanced", description: "Whisper Small + Qwen 1.5B. Recommended." },
    { id: "max", label: "Max", description: "Whisper Large v3 Turbo + Qwen 3B. Best quality, ~3.7 GB, non-commercial." },
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
