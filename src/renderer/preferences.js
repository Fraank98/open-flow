"use strict";

const $ = (sel) => document.querySelector(sel);
const L = window.OpenFlowSettingsLogic;
const api = window.openFlowPrefs;

// ---------------------------------------------------------------- tabs
// Generic: every [role=tab][data-tab=X] pairs with #tab-X. Nothing here lists
// tab ids, so a new section is just a new button and a new panel in the HTML.
const tabButtons = [...document.querySelectorAll('[role="tab"][data-tab]')];
const TAB_IDS = tabButtons.map((b) => b.dataset.tab);
const TAB_KEY = "openflow.settings.tab";

function readStoredTab() {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

function showTab(id, { focus = false } = {}) {
  const target = TAB_IDS.includes(id) ? id : "general";
  for (const btn of tabButtons) {
    const on = btn.dataset.tab === target;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    const panel = document.getElementById("tab-" + btn.dataset.tab);
    if (panel) panel.hidden = !on;
    if (on && focus) btn.focus();
  }
  try {
    localStorage.setItem(TAB_KEY, target);
  } catch {
    /* storage can be unavailable; the tab just isn't remembered */
  }
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabButtons.indexOf(btn);
    const next = tabButtons[(i + (e.key === "ArrowRight" ? 1 : tabButtons.length - 1)) % tabButtons.length];
    showTab(next.dataset.tab, { focus: true });
  });
}

// A hash (set by "Check permissions…" in the tray) wins over the remembered tab.
showTab(location.hash ? L.tabFromHash(location.hash, TAB_IDS) : (readStoredTab() ?? "general"));
api.onShowTab((tab) => showTab(L.tabFromHash("#" + tab, TAB_IDS)));

// ---------------------------------------------------------------- feedback
const statusTimers = new WeakMap();

/** Local feedback line of a panel: "Saved", "Downloaded …", or an error. */
function say(tabId, text, kind) {
  const el = document.querySelector(`#tab-${tabId} .panel-status`);
  if (!el) return;
  clearTimeout(statusTimers.get(el));
  el.textContent = text;
  el.className = "panel-status" + (kind ? " " + kind : "");
  if (kind !== "error" && text) {
    statusTimers.set(el, setTimeout(() => { el.textContent = ""; el.className = "panel-status"; }, 4000));
  }
}

// ---------------------------------------------------------------- restart state
async function refreshRestart() {
  let fields = [];
  try {
    fields = (await api.restartStatus()).fields;
  } catch {
    /* keep the previous state */
    return;
  }
  for (const badge of document.querySelectorAll("[data-restart-for]")) {
    const text = L.restartBadgeFor(badge.dataset.restartFor, fields);
    badge.hidden = !text;
    badge.textContent = text || "";
  }
  $("#restart-banner").hidden = !L.bannerVisible(fields);
}

$("#restart-now").addEventListener("click", () => {
  $("#restart-now").disabled = true;
  $("#restart-now").textContent = "Restarting…";
  api.relaunch();
});

// ---------------------------------------------------------------- init
async function init() {
  const prefs = await api.load();
  const catalog = await api.listModels();

  /** Saves a partial right away; reports in the given tab's status line. */
  async function save(patch, tabId, okText = "Saved") {
    try {
      Object.assign(prefs, await api.update(patch));
      say(tabId, okText, "ok");
    } catch (err) {
      say(tabId, "Couldn't save: " + L.cleanIpcError(err), "error");
    }
    await refreshRestart();
  }

  // Toggles share one rule: the element id is the preference name.
  const toggles = [
    ["launchAtLogin", "general", prefs.launchAtLogin !== false],
    ["useLlmCleanup", "dictation", prefs.useLlmCleanup !== false],
    ["spokenPunctuation", "dictation", prefs.spokenPunctuation === true],
    ["debugLogging", "advanced", prefs.debugLogging === true],
  ];
  for (const [key, tab, value] of toggles) {
    const el = document.getElementById(key);
    el.checked = value;
    el.addEventListener("change", () => save({ [key]: el.checked }, tab));
  }

  // Language
  const langSel = $("#language");
  for (const lang of catalog.languages) {
    const opt = document.createElement("option");
    opt.value = lang.id;
    opt.textContent = lang.label;
    if (lang.id === prefs.language) opt.selected = true;
    langSel.appendChild(opt);
  }
  langSel.addEventListener("change", () => save({ language: langSel.value }, "general"));

  // Dictionary
  let dictTerms = Array.isArray(prefs.dictionary) ? [...prefs.dictionary] : [];

  function renderDict() {
    const list = $("#dictList");
    list.innerHTML = "";
    dictTerms.forEach((term, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "dict-term";
      span.textContent = term;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${term}`);
      rm.addEventListener("click", () => {
        dictTerms.splice(i, 1);
        renderDict();
        void save({ dictionary: dictTerms }, "dictation");
      });
      li.append(span, rm);
      list.appendChild(li);
    });
  }

  function addDictTerm() {
    const input = $("#dictInput");
    const term = input.value.trim();
    if (!term) return;
    // Case-insensitive de-dupe; keep the spelling the user typed last.
    dictTerms = dictTerms.filter((t) => t.toLowerCase() !== term.toLowerCase());
    dictTerms.push(term);
    input.value = "";
    renderDict();
    void save({ dictionary: dictTerms }, "dictation");
    input.focus();
  }

  $("#dictAdd").addEventListener("click", addDictTerm);
  $("#dictInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDictTerm();
    }
  });
  renderDict();

  // ── Reply suggestions ──
  // Every control saves its own field through prefs:update. None of these fields
  // needs a restart: the main process reconfigures the reply server and the
  // shortcut from its onSaved hook.
  let replyApps = Array.isArray(prefs.replyApps) ? [...prefs.replyApps] : [];
  let replyTierId = (catalog.replyTiers.find((t) => t.modelId === prefs.replyModelId) ?? catalog.replyTiers[0]).id;
  // Optimistic until the first status poll lands, so the toggle isn't wrongly
  // disabled in the common case (helper loaded fine).
  let nativeOk = true;

  $("#replyEnabled").checked = prefs.replySuggestionsEnabled === true;
  $("#userDisplayName").value = prefs.userDisplayName ?? "";
  // preferencesStore.load() always merges DEFAULT_PREFS: never undefined here.
  $("#replyHotkey").value = prefs.replySuggestionsHotkey;
  $("#replyAppsMode").value = prefs.replyAppsMode ?? "allowlist";

  function selectedTier() {
    return catalog.replyTiers.find((t) => t.id === replyTierId) ?? catalog.replyTiers[0];
  }

  /** The same list serves both modes; the label and a warning follow the mode. */
  function updateReplyAppsModeUI() {
    const view = L.replyAppsView($("#replyAppsMode").value, replyApps.length);
    $("#replyAppsModeLabel").textContent = view.label;
    const warn = $("#replyAppsModeWarning");
    warn.hidden = !view.warning;
    warn.textContent = view.warning || "";
  }
  $("#replyAppsMode").addEventListener("change", () => {
    updateReplyAppsModeUI();
    void save({ replyAppsMode: $("#replyAppsMode").value }, "reply");
  });

  function renderReplyApps() {
    const list = $("#replyAppList");
    list.innerHTML = "";
    replyApps.forEach((id, i) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "dict-term";
      span.textContent = id;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "danger";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${id}`);
      rm.addEventListener("click", () => {
        replyApps.splice(i, 1);
        renderReplyApps();
        void save({ replyApps }, "reply");
      });
      li.append(span, rm);
      list.appendChild(li);
    });
    // The list content decides which warning applies, so every add/remove refreshes it.
    updateReplyAppsModeUI();
  }
  function addReplyApp(raw) {
    const id = (raw ?? "").trim();
    if (!id) return;
    replyApps = replyApps.filter((a) => a.toLowerCase() !== id.toLowerCase());
    replyApps.push(id);
    renderReplyApps();
    void save({ replyApps }, "reply");
  }
  $("#replyAppAdd").addEventListener("click", () => { addReplyApp($("#replyAppInput").value); $("#replyAppInput").value = ""; });
  $("#replyAppInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addReplyApp($("#replyAppInput").value); $("#replyAppInput").value = ""; }
  });
  renderReplyApps();

  function renderReplyTiers() {
    const container = $("#reply-tiers");
    container.innerHTML = "";
    for (const t of catalog.replyTiers) {
      const row = document.createElement("div");
      row.className = "model-row" + (t.id === replyTierId ? " selected" : "");
      row.dataset.id = t.id;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${t.label} — ${t.description}`;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = L.formatBytes(t.sizeBytes);
      const badge = document.createElement("span");
      badge.className = "badge" + (t.installed ? " installed" : "");
      badge.textContent = t.installed ? "Installed" : "Not downloaded";
      const actions = document.createElement("span");
      actions.className = "row-actions";
      if (!t.installed) {
        const dl = document.createElement("button");
        dl.textContent = "Download";
        dl.addEventListener("click", async (e) => {
          e.stopPropagation();
          dl.disabled = true;
          dl.textContent = "0%";
          const off = api.onDownloadProgress((p) => {
            if (p.id === t.modelId && p.total > 0) dl.textContent = Math.floor((p.bytes / p.total) * 100) + "%";
          });
          try {
            await api.downloadModel("reply", t.modelId);
            t.installed = true;
            renderReplyTiers();
            say("reply", `Downloaded ${t.label}`, "ok");
            // Primary path to turning the feature on: re-run the guard.
            refreshReplyGuards();
          } catch (err) {
            dl.disabled = false;
            dl.textContent = "Retry";
            say("reply", "Download failed: " + L.cleanIpcError(err), "error");
          } finally { off(); }
        });
        actions.appendChild(dl);
      }
      row.append(name, size, badge, actions);
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        replyTierId = t.id;
        renderReplyTiers();
        refreshReplyGuards();
        void save({ replyModelId: t.modelId }, "reply");
      });
      container.appendChild(row);
    }
  }
  renderReplyTiers();

  const HOTKEY_MESSAGES = {
    "contains-option": "Option is used for dictation. Choose another combination.",
    "no-modifier": "Add at least one of Command, Control or Shift.",
    "no-key": "Add a key besides the modifiers.",
    "reserved-key": "1, 2, 3 and Esc are the pill's shortcuts while it is visible.",
  };
  const HOTKEY_HINT = "It can't use Option: dictation does.";
  async function validateHotkeyField() {
    const r = await api.validateReplyHotkey($("#replyHotkey").value.trim());
    const status = $("#replyHotkeyStatus");
    status.textContent = r.ok ? HOTKEY_HINT : (HOTKEY_MESSAGES[r.reason] ?? "That shortcut isn't valid.");
    status.classList.toggle("invalid", !r.ok);
    return r.ok;
  }
  $("#replyHotkey").addEventListener("input", () => { void validateHotkeyField(); });
  // An invalid shortcut is never saved; the reason stays under the field.
  $("#replyHotkey").addEventListener("change", async () => {
    if (await validateHotkeyField()) void save({ replySuggestionsHotkey: $("#replyHotkey").value.trim() }, "reply");
  });

  /**
   * The feature cannot be switched on without a name and without the selected
   * model on disk. The toggle is only ever disabled, never forced off: a
   * preference already saved as "on" (e.g. the model was deleted afterwards)
   * keeps its value, with the impediment spelled out.
   */
  function refreshReplyGuards() {
    const tier = selectedTier();
    const message = L.replyGuardMessage({
      name: $("#userDisplayName").value,
      modelInstalled: tier.installed,
      tierLabel: tier.label,
      nativeOk,
    });
    $("#replyEnabled").disabled = message !== "";
    $("#replyGuard").textContent = message;
  }
  $("#userDisplayName").addEventListener("input", refreshReplyGuards);
  $("#userDisplayName").addEventListener("change", () => {
    void save({ userDisplayName: $("#userDisplayName").value.trim() }, "reply");
  });
  $("#replyEnabled").addEventListener("change", () => {
    void save({ replySuggestionsEnabled: $("#replyEnabled").checked }, "reply");
  });
  refreshReplyGuards();

  async function refreshReplyStatus() {
    const s = await api.replyStatus();
    if (s.nativeOk !== nativeOk) {
      nativeOk = s.nativeOk;
      refreshReplyGuards();
    }
    const parts = [`State: ${s.serverState}`];
    if (s.serverError) parts.push(`error: ${s.serverError}`);
    if (s.serverState === "ready" && !s.hotkeyRegistered) parts.push("shortcut taken by another app");
    $("#replyServerState").textContent = parts.join(" · ");
    const btn = $("#replyAppAddBlocked");
    // lastBlockedBundleId is never cleared once set, so hide the button once
    // that app is already in the list.
    const alreadyListed = s.lastBlockedBundleId
      ? replyApps.some((a) => a.toLowerCase() === s.lastBlockedBundleId.toLowerCase())
      : true;
    if (s.lastBlockedBundleId && !alreadyListed) {
      btn.hidden = false;
      btn.textContent = `Add ${s.lastBlockedBundleId}`;
      btn.onclick = () => addReplyApp(s.lastBlockedBundleId);
    } else {
      btn.hidden = true;
    }
  }
  void refreshReplyStatus();
  const replyStatusTimer = setInterval(() => { void refreshReplyStatus(); }, 2000);
  window.addEventListener("beforeunload", () => clearInterval(replyStatusTimer));

  // ------------------------------------------------------------ models
  const groups = [
    { kind: "whisper", containerId: "whisper-models", models: catalog.whisper, prefKey: "whisperModelId" },
    { kind: "llm", containerId: "llm-models", models: catalog.llm, prefKey: "llmModelId" },
  ];
  const rowRenderers = new Map(); // model id -> () => void

  function refreshStorage() {
    $("#storage-summary").textContent = L.storageSummary([...catalog.whisper, ...catalog.llm]);
  }

  function renderAllRows() {
    for (const fn of rowRenderers.values()) fn();
    refreshStorage();
  }

  // One idempotent renderer per row: it always rebuilds the card from the model
  // state ({installed, downloading}) plus the selected id, and always attaches
  // the handlers, so a row can be re-rendered any number of times without
  // leaving a dead button behind.
  function renderRow(row, m, group) {
    const view = L.modelRowView(m, prefs[group.prefKey]);
    row.classList.toggle("active", view.primaryAction === "active");
    row.innerHTML = "";

    const head = document.createElement("div");
    head.className = "model-head";
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = m.label;
    const badge = document.createElement("span");
    badge.className = "badge";
    if (view.primaryAction === "active") {
      badge.textContent = "Active";
      badge.classList.add("active");
    } else if (m.installed) {
      badge.textContent = "Installed";
      badge.classList.add("installed");
    } else {
      badge.textContent = "Not downloaded";
    }
    head.append(name, badge);

    const desc = document.createElement("div");
    desc.className = "model-desc";
    desc.textContent = m.description;
    row.append(head, desc);

    if (view.licenseNote) {
      const note = document.createElement("div");
      note.className = "license-note";
      note.textContent = view.licenseNote;
      row.appendChild(note);
    }

    const meta = document.createElement("div");
    meta.className = "model-meta";
    meta.textContent = L.modelMeta(m);
    row.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "model-actions";
    row.appendChild(actions);

    if (m.downloading) {
      const wrap = document.createElement("span");
      wrap.className = "dl-progress";
      const bar = document.createElement("progress");
      bar.max = 100;
      bar.value = m.progressPct ?? 0;
      bar.setAttribute("aria-label", `Downloading ${m.label}`);
      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = (m.progressPct ?? 0) + "%";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        m.cancelling = true;
        api.cancelDownload(m.id);
      });
      wrap.append(bar, pct, cancel);
      actions.appendChild(wrap);
      return;
    }

    if (view.primaryAction === "download") {
      const dl = document.createElement("button");
      dl.textContent = m.downloadFailed ? "Retry" : "Download";
      dl.addEventListener("click", () => startDownload(m, group));
      actions.appendChild(dl);
      return;
    }

    if (view.primaryAction === "use") {
      const use = document.createElement("button");
      use.className = "primary";
      use.textContent = "Use";
      use.addEventListener("click", async () => {
        await save({ [group.prefKey]: m.id }, "models", `Now using ${m.label}`);
        renderAllRows();
      });
      actions.appendChild(use);
    }

    if (view.canDelete) {
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        del.disabled = true;
        del.textContent = "Deleting…";
        try {
          await api.deleteModel(group.kind, m.id);
          // Re-read what is on disk rather than assuming the delete worked.
          await refreshModels();
          if (m.installed) say("models", `Couldn't delete ${m.label}: the file is still there.`, "error");
          else say("models", `Deleted ${m.label}`, "ok");
        } catch (err) {
          await refreshModels();
          say("models", "Couldn't delete: " + L.cleanIpcError(err), "error");
        }
        renderAllRows();
      });
      actions.appendChild(del);
    }
  }

  // The main process is the source of truth for what is on disk: after a
  // download or delete settles, re-read it instead of assuming the outcome (a
  // download that "returned" may have been a no-op on a partial file).
  async function refreshModels() {
    try {
      const fresh = await api.listModels();
      for (const f of [...fresh.whisper, ...fresh.llm]) {
        const m = allModels().find((x) => x.id === f.id);
        if (m) m.installed = f.installed;
      }
      return true;
    } catch {
      return false;
    }
  }

  api.onDownloadProgress((p) => {
    const m = allModels().find((x) => x.id === p.id);
    if (!m || !m.downloading || !(p.total > 0)) return;
    const pct = Math.min(100, Math.floor((p.bytes / p.total) * 100));
    if (pct === m.progressPct) return;
    m.progressPct = pct;
    rowRenderers.get(m.id)?.();
  });

  for (const group of groups) {
    const container = $("#" + group.containerId);
    container.innerHTML = "";
    for (const m of group.models) {
      const row = document.createElement("div");
      row.className = "model-card";
      row.dataset.id = m.id;
      container.appendChild(row);
      rowRenderers.set(m.id, () => renderRow(row, m, group));
    }
  }
  renderAllRows();
  // Downloads still running from before this window opened: pick them up.
  for (const group of groups) {
    for (const m of group.models) if (m.downloading) void trackDownload(m, group);
  }

  $("#reveal-models").addEventListener("click", () => api.revealModels());

  // ------------------------------------------------------------ permissions
  const PERMISSIONS = [
    { key: "mic", pane: "microphone", name: "Microphone" },
    { key: "accessibility", pane: "accessibility", name: "Accessibility" },
    { key: "automation", pane: "automation", name: "Automation" },
  ];

  function renderPermissions(status) {
    const list = $("#permissions");
    list.innerHTML = "";
    for (const p of PERMISSIONS) {
      const row = L.permissionRow(status[p.key]);
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "perm-name";
      name.textContent = p.name;
      const state = document.createElement("span");
      state.className = "perm-state" + (row.granted ? " granted" : status[p.key] === "denied" ? " denied" : "");
      state.textContent = row.text;
      li.append(name, state);
      if (!row.granted) {
        const open = document.createElement("button");
        open.textContent = "Open System Settings";
        open.addEventListener("click", () => api.openSystemSettings(p.pane));
        li.appendChild(open);
      }
      list.appendChild(li);
    }
  }

  async function checkPermissions(probeAutomation) {
    try {
      renderPermissions(await api.permissionsStatus({ automation: probeAutomation }));
    } catch (err) {
      say("general", "Couldn't check permissions: " + L.cleanIpcError(err), "error");
    }
  }

  $("#permissions-recheck").addEventListener("click", () => checkPermissions(true));
  // Coming back from System Settings: refresh without running the Automation probe.
  window.addEventListener("focus", () => checkPermissions(false));
  void checkPermissions(false);

  // ------------------------------------------------------------ advanced
  $("#open-logs").addEventListener("click", () => api.openLogs());
  $("#open-project").addEventListener("click", () => api.openProjectPage());
  $("#reset-setup").addEventListener("click", async () => {
    try {
      await api.resetSetup();
    } catch (err) {
      say("advanced", L.cleanIpcError(err), "error");
    }
  });
  api.appInfo().then((info) => {
    $("#app-version").textContent = "open-flow " + info.version;
  }).catch(() => undefined);

  await refreshRestart();
}

init().catch((err) => {
  const target = document.querySelector('[role="tabpanel"]:not([hidden]) .panel-status');
  if (target) {
    target.textContent = "Couldn't load settings: " + L.cleanIpcError(err);
    target.className = "panel-status error";
  }
});
