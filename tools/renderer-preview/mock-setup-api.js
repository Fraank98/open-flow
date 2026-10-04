// Fake window.openFlowSetup for browser previews.
// Query: ?theme=light|dark
//        &step=welcome|permissions|tier|download|ready   (page to land on)
//        &appReady=1 (ready step: the app finished starting)  &ready=accessibility-off|relaunch-needed|paused (ready step: why it isn't)  &pipeline=recording|transcribing|cleaning|pasting|pasted
//        &scenario=fresh|mixed|granted|no-permissions|resume-download|downloading|download-error|no-space|missing-model
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme");
  const scenario = q.get("scenario") || "fresh";
  const step = q.get("step") || "welcome";
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
      transcriptionNote: "Best accuracy. Comfortable on 16 GB, slower on 8 GB.", recommended: false,
      sizeBytes: 1624555275 + 2104932768, ramBytes: 5.1e9, installed: false, licenseNote: LICENSE },
  ];
  // Statuses as the main process reports them. Accessibility is only ever
  // granted/denied (live AX API); mic and automation can also be "unknown".
  // Past the permissions step the wizard only resumes with mic + Accessibility granted.
  const pastPermissions = ["tier", "download", "ready"].includes(step);
  const perms = scenario === "granted"
    ? { mic: "granted", acc: "granted", auto: "granted" }
    : pastPermissions
      ? { mic: "granted", acc: "granted", auto: "unknown" }
    : scenario === "mixed"
      ? { mic: "granted", acc: "denied", auto: "unknown" }
      : { mic: "unknown", acc: "denied", auto: "unknown" };

  // The wizard resumes from the saved step; "ready" cannot be resumed, so it is
  // reached by "resuming" the download and letting it finish instantly.
  const savedStep = step === "ready" ? "download" : step;
  const savedTier = step === "download" || step === "ready" ? "balanced" : null;
  const autoStart = step === "ready" || ["downloading", "download-error", "no-space"].includes(scenario);

  const readyStateCbs = [];
  const pipelineCbs = [];
  const progressCbs = [];
  const doneCbs = [];
  let timer = null;

  const emitProgress = (stage, bytes, total, fileIndex) =>
    progressCbs.forEach((cb) => cb({ stage, bytes, total, fileIndex, fileCount: 2 }));
  const emitDone = (r) => doneCbs.forEach((cb) => cb(r));

  // Deterministic progress for screenshots: a fake clock moving 12 MB/s.
  function scriptedDownload() {
    let fake = 1e12;
    Date.now = () => fake;
    const total = 487601967;
    for (let bytes = 20e6; bytes <= 220e6; bytes += 20e6) {
      fake += 1667;
      emitProgress("Whisper Small", bytes, total, 1);
    }
    if (scenario === "download-error") {
      emitDone({ ok: false, error: { title: "No internet connection",
        hint: "Check your network and try again. Downloads resume where they left off.", retryable: true, code: "network" } });
    } else if (step === "ready") {
      emitDone({ ok: true });
    }
  }

  window.openFlowSetup = {
    getInitialState: () => Promise.resolve({
      micPermission: perms.mic, accessibilityPermission: perms.acc,
      automationPermission: scenario === "granted" ? "granted" : "unknown", tiers,
      setupStep: savedStep, setupTierId: savedTier,
      readyState: "starting",
      setupReason: scenario === "missing-model" ? "missing-model" : null,
      freeBytes: scenario === "no-space" ? 0.9e9 : 42e9, launchAtLogin: true,
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
    saveStep: (p) => console.log("[mock] saveStep", JSON.stringify(p)),
    setLaunchAtLogin: (on) => console.log("[mock] launchAtLogin", on),
    startDownload: () => {
      if (scenario === "no-space") {
        emitDone({ ok: false, error: { title: "Not enough disk space",
          hint: "You need 1.6 GB free but only 0.9 GB is available. Free up space and try again.", retryable: true, code: "no-space" } });
        return Promise.resolve();
      }
      if (autoStart) { scriptedDownload(); return Promise.resolve(); }
      // Interactive preview: Whisper then the cleanup model, with real timing.
      clearInterval(timer);
      const files = [["Whisper Small", 487601967], ["Qwen 2.5 1.5B", 1117320736]];
      let i = 0;
      let bytes = 0;
      timer = setInterval(() => {
        bytes += 20e6;
        const total = files[i][1];
        emitProgress(files[i][0], Math.min(bytes, total), total, i + 1);
        if (bytes >= total) {
          i += 1; bytes = 0;
          if (i === files.length) { clearInterval(timer); emitDone({ ok: true }); }
        }
      }, 250);
      return Promise.resolve();
    },
    cancelDownload: () => {
      clearInterval(timer);
      emitDone({ ok: false, error: { title: "Download paused", hint: "", retryable: true, code: "aborted" } });
    },
    onDownloadProgress: (cb) => { progressCbs.push(cb); return () => progressCbs.splice(progressCbs.indexOf(cb), 1); },
    onDownloadDone: (cb) => { doneCbs.push(cb); return () => doneCbs.splice(doneCbs.indexOf(cb), 1); },
    onReadyState: (cb) => { readyStateCbs.push(cb); return () => readyStateCbs.splice(readyStateCbs.indexOf(cb), 1); },
    relaunch: () => console.log("[mock] relaunch"),
    onPipelineState: (cb) => { pipelineCbs.push(cb); return () => pipelineCbs.splice(pipelineCbs.indexOf(cb), 1); },
    finish: () => console.log("[mock] finish"),
  };

  // Scenarios that show a download in flight press Resume once setup.js has
  // finished its async init (listeners are attached after getInitialState).
  if (autoStart) {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(() => { const b = document.getElementById("dl-resume"); if (b) b.click(); }, 150);
    });
  }

  // The ready step goes live once the app reports ready (after the scripted download).
  const readyParam = q.get("ready") || (q.get("appReady") === "1" ? "ready" : null);
  if (readyParam) {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(() => {
        readyStateCbs.forEach((cb) => cb(readyParam));
        const seq = { recording: ["recording"], transcribing: ["recording", "transcribing"], cleaning: ["recording", "transcribing", "cleaning"],
          pasting: ["recording", "transcribing", "cleaning", "pasting"], pasted: ["recording", "transcribing", "cleaning", "pasting", "idle"] }[q.get("pipeline")] || [];
        seq.forEach((st) => pipelineCbs.forEach((cb) => cb(st)));
      }, 400);
    });
  }
})();
