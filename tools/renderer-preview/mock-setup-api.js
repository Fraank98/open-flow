// Fake window.openFlowSetup for browser previews. Query: ?theme=light|dark&scenario=fresh|no-permissions|granted|download-error&step=permissions
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  const scenario = q.get("scenario") || "fresh";
  // Headless screenshots would otherwise catch the step-in fade mid-animation.
  document.write("<style>*{animation:none!important;transition:none!important}</style>");

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
  // Statuses as the main process reports them. Accessibility is only ever
  // granted/denied (live AX API); mic and automation can also be "unknown".
  const perms = scenario === "granted"
    ? { mic: "granted", acc: "granted", auto: "granted" }
    : scenario === "no-permissions"
      ? { mic: "unknown", acc: "denied", auto: "unknown" }
      : { mic: "unknown", acc: "denied", auto: "unknown" };

  const progressCbs = [];
  const doneCbs = [];
  let timer = null;

  window.openFlowSetup = {
    getInitialState: () => Promise.resolve({
      micPermission: perms.mic, accessibilityPermission: perms.acc,
      automationPermission: scenario === "granted" ? "granted" : "unknown", tiers,
    }),
    requestMicPermission: () => { perms.mic = "granted"; return Promise.resolve("granted"); },
    requestAccessibility: () => Promise.resolve(perms.acc),
    // Like the real API: automation is null unless it was asked for.
    refreshPermissions: (opts) => Promise.resolve({
      mic: perms.mic, accessibility: perms.acc,
      automation: opts && opts.automation ? perms.auto : null,
    }),
    // Pretend the user flips the switch in System Settings.
    openSystemSettings: (pane) => {
      if (pane === "accessibility") perms.acc = "granted";
      else if (pane === "microphone") perms.mic = "granted";
      else if (pane === "automation") perms.auto = "granted";
    },
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

  // ?step=permissions jumps past the welcome step (listeners are attached
  // synchronously by setup.js, so a click at DOMContentLoaded is safe).
  if (q.get("step") === "permissions") {
    document.addEventListener("DOMContentLoaded", () => {
      const btn = document.querySelector('button[data-next="permissions"]');
      if (btn) btn.click();
    });
  }
})();
