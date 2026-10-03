"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Ordered list of steps; drives the stepper and progress highlighting.
const STEPS = ["welcome", "permissions", "tier", "download", "done"];
let currentStep = "welcome";

let state = {
  micPermission: "unknown",
  accessibilityPermission: "unknown",
  automationPermission: "unknown",
  tiers: [],
};
// The Automation probe can raise a macOS prompt, so it only runs after the user
// has asked for it (button click); from then on it is re-checked on focus.
let automationAsked = false;
let permissionTimer = null;
let selectedTierId = null;

function buildStepper() {
  const ol = $("#stepper");
  ol.innerHTML = "";
  for (const id of STEPS) {
    const li = document.createElement("li");
    li.dataset.id = id;
    ol.appendChild(li);
  }
}

function goto(stepId) {
  currentStep = stepId;
  $$(".step").forEach((el) => el.classList.remove("active"));
  $("#step-" + stepId).classList.add("active");

  // Reflect progress in the stepper.
  const idx = STEPS.indexOf(stepId);
  $$("#stepper li").forEach((li, i) => {
    li.classList.toggle("done", i < idx);
    li.classList.toggle("current", i === idx);
    li.classList.toggle("upcoming", i > idx);
  });

  // Move focus to the step heading so keyboard/screen-reader users land on the
  // new content instead of a now-hidden button.
  const heading = $("#step-" + stepId + " h2");
  if (heading) heading.focus();

  // Poll the cheap permissions (mic, Accessibility) only while that step is visible.
  clearInterval(permissionTimer);
  permissionTimer = null;
  if (stepId === "permissions") permissionTimer = setInterval(() => recheckPermissions(), 1000);
}

// ---- Permissions ----------------------------------------------------------

const Logic = globalThis.OpenFlowSetupLogic;

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

function selectTier(id, { focus = false } = {}) {
  selectedTierId = id;
  $$(".tier").forEach((el) => {
    const on = el.dataset.id === id;
    el.setAttribute("aria-checked", String(on));
    el.tabIndex = on ? 0 : -1; // roving tabindex
    if (on && focus) el.focus();
  });
  $("#tier-continue").disabled = false;
}

function renderTiers() {
  const list = $("#tier-list");
  list.innerHTML = "";
  state.tiers.forEach((t, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tier";
    el.setAttribute("role", "radio");
    el.setAttribute("aria-checked", "false");
    el.tabIndex = i === 0 ? 0 : -1;
    el.dataset.id = t.id;
    el.innerHTML = `<strong></strong><span class="desc"></span>`;
    el.querySelector("strong").textContent = t.label;
    // Interim copy until the wizard rewrite: model pair, size and the notes.
    el.querySelector(".desc").textContent =
      `${t.summary} · ${formatSize(t.sizeBytes)} download. ${t.transcriptionNote}` +
      (t.licenseNote ? ` ${t.licenseNote}` : "");
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
}

// ---- Download -------------------------------------------------------------

function formatSize(bytes) {
  if (!bytes || bytes < 0) return "0 MB";
  const gb = bytes / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + " GB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

async function startDownload() {
  $("#dl-error").classList.add("hidden");
  $("#dl-actions").classList.add("hidden");
  $("#dl-hint").classList.remove("hidden");
  $("#dl-stage").textContent = "Preparing…";
  $("#dl-progress").removeAttribute("value"); // indeterminate until first progress
  $("#dl-bytes").textContent = "";
  try {
    await window.openFlowSetup.startDownload(selectedTierId);
  } catch (err) {
    showDownloadError(err && err.message ? err.message : String(err));
  }
}

function showDownloadError(msg) {
  $("#dl-hint").classList.add("hidden");
  const box = $("#dl-error");
  box.textContent = "Download failed: " + (msg || "unknown error");
  box.classList.remove("hidden");
  $("#dl-actions").classList.remove("hidden");
}

// ---- Init -----------------------------------------------------------------

function showFatal(msg) {
  const root = $("#root");
  root.innerHTML =
    `<header><h1>open-flow</h1></header>` +
    `<section class="step active"><h2>Something went wrong</h2>` +
    `<p class="muted">${msg}</p>` +
    `<div class="actions"><button class="primary" id="fatal-reload">Try again</button></div></section>`;
  const btn = document.getElementById("fatal-reload");
  if (btn) btn.addEventListener("click", () => location.reload());
}

async function init() {
  buildStepper();
  goto("welcome");

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
  $("#dl-back").addEventListener("click", () => goto("tier"));

  window.openFlowSetup.onDownloadProgress(({ stage, bytes, total }) => {
    $("#dl-stage").textContent = stage;
    if (total > 0) {
      $("#dl-progress").value = Math.floor((bytes / total) * 100);
      $("#dl-bytes").textContent = `${formatSize(bytes)} / ${formatSize(total)}`;
    } else {
      $("#dl-progress").removeAttribute("value");
    }
  });
  window.openFlowSetup.onDownloadDone(({ ok, error }) => {
    if (ok) goto("done");
    else showDownloadError(error);
  });

  $("#done-finish").addEventListener("click", () => window.openFlowSetup.finish());
}

async function recheckPermissions({ automation = false } = {}) {
  if (automation) automationAsked = true;
  try {
    const fresh = await window.openFlowSetup.refreshPermissions({ automation });
    state.micPermission = fresh.mic;
    state.accessibilityPermission = fresh.accessibility;
    if (fresh.automation) state.automationPermission = fresh.automation;
    applyPermissions();
  } catch { /* transient; leave current state */ }
}

init();
