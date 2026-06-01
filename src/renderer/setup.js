"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Ordered list of steps; drives the stepper and progress highlighting.
const STEPS = ["welcome", "permissions", "tier", "download", "done"];
let currentStep = "welcome";

let state = { micPermission: "unknown", accessibilityPermission: "unknown", tiers: [] };
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
}

// ---- Permissions ----------------------------------------------------------

function renderMic(perm) {
  const status = $("#mic-status");
  status.textContent = perm === "granted" ? "granted" : perm === "denied" ? "denied" : "not granted";
  status.classList.toggle("granted", perm === "granted");
  status.classList.toggle("denied", perm === "denied");
  // Once the OS prompt has been answered we can't re-prompt in-app: a denied
  // mic can only be fixed in System Settings, so swap the button accordingly.
  $("#mic-request").classList.toggle("hidden", perm !== "unknown");
  $("#mic-open").classList.toggle("hidden", perm !== "denied");
}

function renderAccessibility(perm) {
  const status = $("#acc-status");
  status.textContent = perm === "granted" ? "granted" : perm === "denied" ? "denied" : "not granted";
  status.classList.toggle("granted", perm === "granted");
  status.classList.toggle("denied", perm === "denied");
  // Granted → nothing left to do here; hide the action buttons.
  $("#acc-open").classList.toggle("hidden", perm === "granted");
  $("#acc-refresh").classList.toggle("hidden", perm === "granted");
}

function updateContinue() {
  const ok = state.micPermission === "granted" && state.accessibilityPermission === "granted";
  $("#perm-continue").disabled = !ok;
}

function applyPermissions() {
  renderMic(state.micPermission);
  renderAccessibility(state.accessibilityPermission);
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
    el.querySelector(".desc").textContent = t.description;
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
  $("#mic-open").addEventListener("click", () => window.openFlowSetup.openMicSettings());

  $("#acc-open").addEventListener("click", () => window.openFlowSetup.openAccessibilitySettings());
  $("#acc-refresh").addEventListener("click", recheckPermissions);

  // macOS Accessibility/Mic are toggled in System Settings, outside this window.
  // Re-check whenever the user comes back so they don't have to hit "Re-check".
  window.addEventListener("focus", () => {
    if (currentStep === "permissions") recheckPermissions();
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

async function recheckPermissions() {
  try {
    const fresh = await window.openFlowSetup.getInitialState();
    state.micPermission = fresh.micPermission;
    state.accessibilityPermission = fresh.accessibilityPermission;
    applyPermissions();
  } catch { /* transient; leave current state */ }
}

init();
