"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const Logic = globalThis.OpenFlowSetupLogic;

// Ordered list of steps; drives the stepper and progress highlighting.
const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "permissions", label: "Permissions" },
  { id: "tier", label: "Quality" },
  { id: "download", label: "Download" },
  { id: "ready", label: "Ready" },
];
let currentStep = "welcome";

let state = {
  micPermission: "unknown",
  accessibilityPermission: "unknown",
  automationPermission: "unknown",
  tiers: [],
  freeBytes: null,
};
// The Automation probe can raise a macOS prompt, so it only runs after the user
// has asked for it (button click); from then on it is re-checked on focus.
let automationAsked = false;
let permissionTimer = null;
let selectedTierId = null;

function buildStepper() {
  const ol = $("#stepper");
  ol.innerHTML = "";
  for (const step of STEPS) {
    const li = document.createElement("li");
    li.dataset.id = step.id;
    li.textContent = step.label;
    ol.appendChild(li);
  }
}

// Steps up to "download" are remembered so an interrupted setup can resume;
// "ready" is saved by the main process when the models are in place.
function saveProgress(stepId) {
  if (stepId === "ready") return;
  try {
    window.openFlowSetup.saveStep({ step: stepId, tierId: selectedTierId });
  } catch { /* progress is best effort */ }
}

function goto(stepId, { save = true } = {}) {
  currentStep = stepId;
  $$(".step").forEach((el) => el.classList.remove("active"));
  $("#step-" + stepId).classList.add("active");

  // Reflect progress in the stepper.
  const idx = STEPS.findIndex((st) => st.id === stepId);
  $$("#stepper li").forEach((li, i) => {
    li.classList.toggle("done", i < idx);
    li.classList.toggle("current", i === idx);
    li.classList.toggle("upcoming", i > idx);
    if (i === idx) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });

  // Move focus to the step heading so keyboard/screen-reader users land on the
  // new content instead of a now-hidden button.
  const heading = $("#step-" + stepId + " h2");
  if (heading) heading.focus();

  if (save) saveProgress(stepId);

  // Poll the cheap permissions (mic, Accessibility) only while that step is visible.
  clearInterval(permissionTimer);
  permissionTimer = null;
  if (stepId === "permissions") permissionTimer = setInterval(() => recheckPermissions(), 1000);
}

// ---- Permissions ----------------------------------------------------------

function renderBadge(sel, perm) {
  const status = $(sel);
  const badge = Logic.permissionBadge(perm);
  status.textContent = badge.text;
  status.classList.remove("granted", "denied", "pending");
  status.classList.add(badge.cls);
}

function renderMic(perm) {
  renderBadge("#mic-status", perm);
  // Once the OS prompt has been answered we can't re-prompt in-app: a denied
  // mic can only be fixed in System Settings, so swap the button accordingly.
  $("#mic-request").classList.toggle("hidden", perm !== "unknown");
  $("#mic-open").classList.toggle("hidden", perm !== "denied");
}

function renderAccessibility(perm) {
  renderBadge("#acc-status", perm);
  // Granted → nothing left to do here; hide the action button.
  $("#acc-open").classList.toggle("hidden", perm === "granted");
}

function renderAutomation(perm) {
  renderBadge("#auto-status", perm);
  $("#auto-request").classList.toggle("hidden", perm !== "unknown");
  $("#auto-open").classList.toggle("hidden", perm !== "denied");
}

function updateContinue() {
  $("#perm-continue").disabled = !Logic.canContinuePermissions(state);
}

function applyPermissions() {
  renderMic(state.micPermission);
  renderAccessibility(state.accessibilityPermission);
  renderAutomation(state.automationPermission);
  updateContinue();
}

// ---- Tiers (keyboard-accessible radiogroup) -------------------------------

function selectedTier() {
  return state.tiers.find((t) => t.id === selectedTierId);
}

function renderFreeSpace() {
  const el = $("#free-space");
  const info = Logic.freeSpaceInfo(state.freeBytes, selectedTier());
  el.classList.toggle("hidden", !info);
  if (!info) return;
  el.textContent = info.text;
  el.classList.toggle("low", info.low);
}

function selectTier(id, { focus = false, persist = true } = {}) {
  selectedTierId = id;
  $$(".tier").forEach((el) => {
    const on = el.dataset.id === id;
    el.setAttribute("aria-checked", String(on));
    el.tabIndex = on ? 0 : -1; // roving tabindex
    if (on && focus) el.focus();
  });
  $("#tier-continue").disabled = false;
  renderFreeSpace();
  if (persist) saveProgress("tier");
}

function addBadge(parent, text, cls) {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? " " + cls : "");
  b.textContent = text;
  parent.appendChild(b);
}

function renderTiers() {
  const list = $("#tier-list");
  list.innerHTML = "";
  state.tiers.forEach((t) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tier";
    el.setAttribute("role", "radio");
    el.setAttribute("aria-checked", "false");
    el.tabIndex = -1;
    el.dataset.id = t.id;

    const head = document.createElement("span");
    head.className = "tier-head";
    const title = document.createElement("span");
    title.className = "tier-title";
    title.textContent = t.label;
    head.appendChild(title);
    if (t.recommended) addBadge(head, "Recommended");
    if (t.installed) addBadge(head, "Already on this Mac", "soft");
    el.appendChild(head);

    const lines = Logic.tierCardLines(t);
    lines.forEach((text, i) => {
      const line = document.createElement("span");
      line.className = "tier-line";
      if (i === 0) line.classList.add("tier-summary");
      if (t.licenseNote && i === lines.length - 1) line.classList.add("license-note");
      line.textContent = text;
      el.appendChild(line);
    });

    el.addEventListener("click", () => selectTier(t.id));
    list.appendChild(el);
  });

  // Arrow keys move selection within the group, like native radios.
  list.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const ids = state.tiers.map((t) => t.id);
    const cur = ids.indexOf(selectedTierId);
    const start = cur === -1 ? 0 : cur;
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = (start + delta + ids.length) % ids.length;
    selectTier(ids[next], { focus: true });
  });

  // Preselect the saved choice, else the recommended level.
  const saved = state.tiers.find((t) => t.id === state.setupTierId);
  const preferred = saved || state.tiers.find((t) => t.recommended) || state.tiers[0];
  if (preferred) selectTier(preferred.id, { persist: false });
}

// ---- Download -------------------------------------------------------------

// "running" | "paused" | "error": decides which parts of the step are visible.
let downloadView = "running";
let cancelling = false;
let samples = [];
let lastFileIndex = 0;

function showDownloadView(view, error) {
  downloadView = view;
  const running = view === "running";
  $("#dl-progress-box").classList.toggle("hidden", !running);
  $("#dl-hint").classList.toggle("hidden", !running);
  $("#dl-cancel").classList.toggle("hidden", !running);
  $("#dl-paused").classList.toggle("hidden", view !== "paused");
  $("#dl-resume").classList.toggle("hidden", view !== "paused");
  $("#dl-smaller").classList.toggle("hidden", view !== "paused");
  $("#dl-error").classList.toggle("hidden", view !== "error");
  const retryable = !!(error && error.retryable);
  $("#dl-retry").classList.toggle("hidden", !(view === "error" && retryable));
  $("#dl-other").classList.toggle("hidden", view !== "error");
  if (view === "error") {
    $("#dl-error-title").textContent = error.title || "Download failed";
    $("#dl-error-hint").textContent = error.hint || "";
  }
}

async function startDownload() {
  samples = [];
  lastFileIndex = 0;
  cancelling = false;
  $("#dl-cancel").disabled = false;
  showDownloadView("running");
  $("#dl-stage").textContent = "Preparing…";
  $("#dl-progress").removeAttribute("value"); // indeterminate until first progress
  $("#dl-bytes").textContent = "";
  try {
    await window.openFlowSetup.startDownload(selectedTierId);
  } catch (err) {
    showDownloadView("error", {
      title: "Download failed",
      hint: err && err.message ? err.message : String(err),
      retryable: true,
    });
  }
}

function onProgress({ stage, bytes, total, fileIndex, fileCount }) {
  if (downloadView !== "running") return;
  if (fileIndex !== lastFileIndex) {
    samples = []; // speed is per file
    lastFileIndex = fileIndex;
  }
  samples.push({ t: Date.now(), bytes });
  // Bounded to the stats window: see pruneSamples.
  samples = Logic.pruneSamples(samples);
  $("#dl-stage").textContent = fileCount > 1 ? `${stage} (${fileIndex} of ${fileCount})` : stage;
  if (total > 0) {
    $("#dl-progress").value = Math.floor((bytes / total) * 100);
    const stats = Logic.downloadStats(samples, total);
    const parts = [`${Logic.formatBytes(bytes)} of ${Logic.formatBytes(total)}`];
    if (stats.bytesPerSec > 0) parts.push(`${Logic.formatBytes(stats.bytesPerSec)}/s`);
    const eta = Logic.formatEta(stats.etaSec);
    if (eta) parts.push(eta);
    $("#dl-bytes").textContent = parts.join(" · ");
  } else {
    $("#dl-progress").removeAttribute("value");
  }
}

function onDone({ ok, error }) {
  if (ok) {
    goto("ready", { save: false });
    return;
  }
  if (error && error.code === "aborted") showDownloadView("paused");
  else showDownloadView("error", error || { title: "Download failed", hint: "", retryable: true });
}

// ---- Ready: live "try it" guide ---------------------------------------------

let lastPipelineState = "idle";

// Final step: the live guide once armed, otherwise why dictation isn't active yet.
function showReadyState(readyState) {
  const view = Logic.readyView(readyState);
  $("#ready-starting").classList.toggle("hidden", view.live);
  $("#ready-starting").textContent = view.text;
  $("#ready-live").classList.toggle("hidden", !view.live);
  $("#ready-actions").classList.toggle("hidden", !view.action);
  $("#ready-open-acc").classList.toggle("hidden", view.action !== "open-accessibility");
  $("#ready-relaunch").classList.toggle("hidden", view.action !== "relaunch");
}

function showPipelineState(next) {
  const view = Logic.pipelineView(lastPipelineState, next);
  lastPipelineState = next;
  const el = $("#live-status");
  el.textContent = Logic.readyStepText(view);
  el.classList.toggle("pasted", view === "pasted");
}

// ---- Init -----------------------------------------------------------------

function showFatal(msg) {
  const root = $("#root");
  root.textContent = "";
  const header = document.createElement("header");
  const h1 = document.createElement("h1");
  h1.textContent = "open-flow";
  header.appendChild(h1);
  const section = document.createElement("section");
  section.className = "step active";
  const h2 = document.createElement("h2");
  h2.textContent = "Something went wrong";
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = msg;
  const actions = document.createElement("div");
  actions.className = "actions";
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "Try again";
  btn.addEventListener("click", () => location.reload());
  actions.appendChild(btn);
  section.append(h2, p, actions);
  root.append(header, section);
}

async function init() {
  buildStepper();
  goto("welcome", { save: false });

  // Step navigation (generic next/back buttons).
  $$("button[data-next]").forEach((b) => b.addEventListener("click", () => goto(b.dataset.next)));
  $$("button[data-back]").forEach((b) => b.addEventListener("click", () => goto(b.dataset.back)));

  let initial;
  try {
    initial = await window.openFlowSetup.getInitialState();
  } catch (err) {
    showFatal("Couldn't start setup: " + (err && err.message ? err.message : String(err)));
    return;
  }
  state = initial;
  applyPermissions();
  renderTiers();
  $("#login-toggle").checked = state.launchAtLogin !== false;

  $("#mic-request").addEventListener("click", async () => {
    try {
      state.micPermission = await window.openFlowSetup.requestMicPermission();
    } catch { state.micPermission = "denied"; }
    applyPermissions();
  });
  $("#mic-open").addEventListener("click", () => window.openFlowSetup.openSystemSettings("microphone"));

  // Asking first is what makes open-flow show up in the Accessibility list.
  $("#acc-open").addEventListener("click", async () => {
    try {
      state.accessibilityPermission = await window.openFlowSetup.requestAccessibility();
    } catch { /* fall through to the settings pane */ }
    applyPermissions();
    if (state.accessibilityPermission !== "granted") window.openFlowSetup.openSystemSettings("accessibility");
  });

  $("#auto-request").addEventListener("click", () => recheckPermissions({ automation: true }));
  $("#auto-open").addEventListener("click", () => window.openFlowSetup.openSystemSettings("automation"));

  // Settings are toggled outside this window; Automation is a process spawn, so
  // it is re-checked on focus (not on the timer), and only once the user asked.
  window.addEventListener("focus", () => {
    if (currentStep === "permissions") recheckPermissions({ automation: automationAsked });
  });

  $("#tier-continue").addEventListener("click", async () => {
    goto("download");
    await startDownload();
  });

  $("#dl-retry").addEventListener("click", startDownload);
  $("#dl-resume").addEventListener("click", startDownload);
  $("#dl-cancel").addEventListener("click", () => {
    if (cancelling) return;
    cancelling = true;
    $("#dl-cancel").disabled = true;
    window.openFlowSetup.cancelDownload();
  });
  $("#dl-smaller").addEventListener("click", () => goto("tier"));
  $("#dl-other").addEventListener("click", () => goto("tier"));

  window.openFlowSetup.onDownloadProgress(onProgress);
  window.openFlowSetup.onDownloadDone(onDone);

  // The wizard stays open while the app finishes starting; these keep the last step live.
  showReadyState(state.readyState);
  window.openFlowSetup.onReadyState(showReadyState);
  $("#ready-open-acc").addEventListener("click", () => window.openFlowSetup.openSystemSettings("accessibility"));
  $("#ready-relaunch").addEventListener("click", () => window.openFlowSetup.relaunch());
  window.openFlowSetup.onPipelineState(showPipelineState);

  $("#login-toggle").addEventListener("change", (e) => window.openFlowSetup.setLaunchAtLogin(e.target.checked));
  $("#ready-finish").addEventListener("click", () => window.openFlowSetup.finish());

  // Pick up where an interrupted setup stopped. A saved download is shown as
  // paused: it resumes only when the user says so.
  const step = Logic.resumeStep(state);
  goto(step, { save: false });
  if (step === "download") showDownloadView("paused");
}

// An Automation probe can sit on an unanswered macOS prompt for a while; focus
// events during that time must not stack more osascript runs behind it.
let automationProbeInFlight = false;

async function recheckPermissions({ automation = false } = {}) {
  if (automation) {
    if (automationProbeInFlight) return;
    automationProbeInFlight = true;
    automationAsked = true;
  }
  try {
    const fresh = await window.openFlowSetup.refreshPermissions({ automation });
    state.micPermission = fresh.mic;
    state.accessibilityPermission = fresh.accessibility;
    if (fresh.automation) state.automationPermission = fresh.automation;
    applyPermissions();
  } catch { /* transient; leave current state */ } finally {
    if (automation) automationProbeInFlight = false;
  }
}

init();
