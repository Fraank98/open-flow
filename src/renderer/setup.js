"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function goto(stepId) {
  $$(".step").forEach((el) => el.classList.remove("active"));
  $("#step-" + stepId).classList.add("active");
}

let state = { micPermission: "unknown", accessibilityPermission: "unknown", tiers: [] };
let selectedTierId = null;

function renderPermissionStatus(elId, perm) {
  const el = $("#" + elId);
  el.textContent = perm;
  el.classList.remove("granted", "denied");
  if (perm === "granted") el.classList.add("granted");
  else if (perm === "denied") el.classList.add("denied");
}

function updateContinue() {
  const ok = state.micPermission === "granted" && state.accessibilityPermission === "granted";
  $("#perm-continue").disabled = !ok;
}

function renderTiers() {
  const list = $("#tier-list");
  list.innerHTML = "";
  for (const t of state.tiers) {
    const el = document.createElement("div");
    el.className = "tier";
    el.dataset.id = t.id;
    el.innerHTML = `<strong>${t.label}</strong><div class="desc">${t.description}</div>`;
    el.addEventListener("click", () => {
      selectedTierId = t.id;
      $$(".tier").forEach((x) => x.classList.toggle("selected", x.dataset.id === t.id));
      $("#tier-continue").disabled = false;
    });
    list.appendChild(el);
  }
}

async function init() {
  state = await window.openFlowSetup.getInitialState();
  renderPermissionStatus("mic-status", state.micPermission);
  renderPermissionStatus("acc-status", state.accessibilityPermission);
  updateContinue();
  renderTiers();

  $$("button[data-next]").forEach((btn) => {
    btn.addEventListener("click", () => goto(btn.dataset.next));
  });

  $("#mic-request").addEventListener("click", async () => {
    const result = await window.openFlowSetup.requestMicPermission();
    state.micPermission = result;
    renderPermissionStatus("mic-status", result);
    updateContinue();
  });

  $("#acc-open").addEventListener("click", () => {
    window.openFlowSetup.openAccessibilitySettings();
  });
  $("#acc-refresh").addEventListener("click", async () => {
    const result = await window.openFlowSetup.refreshAccessibilityStatus();
    state.accessibilityPermission = result;
    renderPermissionStatus("acc-status", result);
    updateContinue();
  });

  async function startDownload() {
    $("#dl-error").classList.add("hidden");
    $("#dl-actions").classList.add("hidden");
    $("#dl-stage").textContent = "Preparing…";
    $("#dl-progress").value = 0;
    $("#dl-bytes").textContent = "";
    await window.openFlowSetup.startDownload(selectedTierId);
  }

  $("#tier-continue").addEventListener("click", async () => {
    goto("download");
    await startDownload();
  });

  $("#dl-retry").addEventListener("click", async () => {
    await startDownload();
  });
  $("#dl-back").addEventListener("click", () => {
    goto("tier");
  });

  window.openFlowSetup.onDownloadProgress(({ stage, bytes, total }) => {
    $("#dl-stage").textContent = stage;
    const pct = total > 0 ? Math.floor((bytes / total) * 100) : 0;
    $("#dl-progress").value = pct;
    $("#dl-bytes").textContent = `${(bytes / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB`;
  });
  window.openFlowSetup.onDownloadDone(({ ok, error }) => {
    if (ok) {
      goto("done");
    } else {
      $("#dl-error").classList.remove("hidden");
      $("#dl-error").textContent = "Download failed: " + (error ?? "unknown");
      $("#dl-actions").classList.remove("hidden");
    }
  });

  $("#done-finish").addEventListener("click", () => {
    window.openFlowSetup.finish();
  });
}

init();
