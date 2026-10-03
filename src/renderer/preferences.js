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
  let replyApps = Array.isArray(prefs.replyApps) ? [...prefs.replyApps] : [];
  let replyTierId = (catalog.replyTiers.find((t) => t.modelId === prefs.replyModelId) ?? catalog.replyTiers[0]).id;

  $("#replyEnabled").checked = prefs.replySuggestionsEnabled === true;
  $("#userDisplayName").value = prefs.userDisplayName ?? "";
  // No `?? "Command+Control+R"` fallback: preferencesStore.load() always
  // merges DEFAULT_PREFS, so replySuggestionsHotkey is never undefined here
  // (found by review, Minor 8.3 — the fallback was dead code and a third
  // copy of the same literal, alongside utils/reply-hotkey.ts and
  // preferences-store.ts).
  $("#replyHotkey").value = prefs.replySuggestionsHotkey;
  $("#replyAppsMode").value = prefs.replyAppsMode ?? "allowlist";

  /** The same list serves both modes, and switching the dropdown silently
   *  redefines what it means: allowlist reads ONLY these apps, blocklist
   *  reads every app EXCEPT these. The label and a warning change with the
   *  mode instead of leaving that to the reader to notice on their own. */
  function updateReplyAppsModeUI() {
    const mode = $("#replyAppsMode").value;
    $("#replyAppsModeLabel").textContent = mode === "blocklist" ? "App da escludere" : "App in cui leggere";
    const warn = $("#replyAppsModeWarning");
    if (mode !== "blocklist") {
      warn.hidden = true;
      return;
    }
    warn.hidden = false;
    warn.textContent = replyApps.length > 0
      ? "In tutte le altre app il contesto verrà letto."
      : "Nessuna app esclusa: con questa impostazione la feature non leggerà nulla.";
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
    // The list content decides which blocklist warning applies (empty vs
    // non-empty), so every add/remove must refresh it too, not just a mode
    // switch.
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
      size.textContent = `${(t.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
      const badge = document.createElement("span");
      badge.className = "badge" + (t.installed ? " installed" : "");
      badge.textContent = t.installed ? "installed" : "not installed";
      const actions = document.createElement("span");
      actions.className = "row-actions";
      if (!t.installed) {
        const dl = document.createElement("button");
        dl.textContent = "Download";
        dl.addEventListener("click", async (e) => {
          e.stopPropagation();
          dl.disabled = true;
          dl.textContent = "0%";
          const off = window.openFlowPrefs.onDownloadProgress((p) => {
            if (p.id === t.modelId && p.total > 0) dl.textContent = Math.floor((p.bytes / p.total) * 100) + "%";
          });
          try {
            await window.openFlowPrefs.downloadModel("reply", t.modelId);
            t.installed = true;
            renderReplyTiers();
            say("reply", `Scaricato ${t.label}.`, "ok");
            // This is the primary path to turning the feature on: without
            // this the checkbox stays disabled, with no explanation, until
            // something unrelated (a name edit, a tier click) happens to
            // re-run the guard.
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

  function selectedTier() {
    return catalog.replyTiers.find((t) => t.id === replyTierId) ?? catalog.replyTiers[0];
  }

  const HOTKEY_MESSAGES = {
    "contains-option": "Option è riservata alla dettatura (Hold Option): scegli un'altra combinazione.",
    "no-modifier": "Serve almeno un modificatore (Command, Control, Shift).",
    "no-key": "Serve un tasto oltre ai modificatori.",
    "reserved-key": "1, 2, 3 ed Esc sono le scorciatoie della pill mentre è visibile.",
  };
  /** Gates the global Save button only while the feature is (or is being
   *  left) switched on: an invalid hotkey sitting in this field must not
   *  block saving an unrelated change — language, dictionary, models —
   *  while the feature is off. */
  async function validateHotkeyField() {
    const r = await window.openFlowPrefs.validateReplyHotkey($("#replyHotkey").value.trim());
    $("#replyHotkeyStatus").textContent = r.ok
      ? "Non può contenere Option: la dettatura usa Hold Option."
      : (HOTKEY_MESSAGES[r.reason] ?? "Acceleratore non valido.");
    return r.ok;
  }
  $("#replyHotkey").addEventListener("input", () => { void validateHotkeyField(); });
  // An invalid shortcut is never saved; the reason stays under the field.
  $("#replyHotkey").addEventListener("change", async () => {
    if (await validateHotkeyField()) void save({ replySuggestionsHotkey: $("#replyHotkey").value.trim() }, "reply");
  });

  /** The feature cannot be switched on without a name and without the tier's
   *  model on disk: the parser cannot assign roles without the name, and the
   *  server cannot start without the file. Never force the checkbox off —
   *  a preference already saved as "on" (e.g. the tier's model was deleted
   *  after enabling) must not silently flip to "off" on some unrelated Save
   *  just because Preferences happened to be reopened: it stays disabled,
   *  with the impediment spelled out, and whatever it already was is what
   *  gets saved. */
  function refreshReplyGuards() {
    const tier = selectedTier();
    const nameOk = $("#userDisplayName").value.trim().length > 0;
    const box = $("#replyEnabled");
    const blockers = [];
    if (!nameOk) blockers.push("inserisci il tuo nome");
    if (!tier.installed) blockers.push(`scarica ${tier.label}`);
    // Same fixed string refreshReplyStatus already shows in the status line
    // below (no new copy): without this, checking the box while the native
    // addon failed to load starts the reply llama-server for a feature that
    // can never register a hotkey (found by review — Important 2).
    if (!nativeOk) blockers.push("addon non caricabile: feature disattivata per questa sessione");
    box.disabled = blockers.length > 0;
    $("#replyGuard").textContent = blockers.length > 0 ? `Per accendere le proposte di risposta: ${blockers.join(", ")}.` : "";
    // The checkbox's checked state is one of the two inputs to the Save
    // gate above, so a guard refresh (which can follow a checkbox change)
    // must recompute it too.
    void validateHotkeyField();
  }
  $("#userDisplayName").addEventListener("input", refreshReplyGuards);
  $("#userDisplayName").addEventListener("change", () => {
    void save({ userDisplayName: $("#userDisplayName").value.trim() }, "reply");
  });
  $("#replyEnabled").addEventListener("change", () => {
    refreshReplyGuards();
    void save({ replySuggestionsEnabled: $("#replyEnabled").checked }, "reply");
  });
  // Optimistic default: the first refreshReplyStatus() (async) hasn't landed
  // yet when refreshReplyGuards() first runs below, so the checkbox isn't
  // wrongly disabled for the common case (addon loaded fine) while waiting.
  let nativeOk = true;
  refreshReplyGuards();

  async function refreshReplyStatus() {
    const s = await window.openFlowPrefs.replyStatus();
    if (s.nativeOk !== nativeOk) {
      nativeOk = s.nativeOk;
      refreshReplyGuards();
    }
    const parts = [`stato: ${s.serverState}`];
    if (s.serverError) parts.push(`errore: ${s.serverError}`);
    if (!s.nativeOk) parts.push("addon non caricabile: feature disattivata per questa sessione");
    if (s.serverState === "ready" && !s.hotkeyRegistered) parts.push("scorciatoia occupata da un'altra app");
    $("#replyServerState").textContent = `Modello di risposta — ${parts.join(" · ")}`;
    const btn = $("#replyAppAddBlocked");
    // lastBlockedBundleId is never cleared once set (it survives past apps
    // the user has since added), so the button must hide itself once that
    // app is already in the list — otherwise it stays on screen forever
    // after being acted on.
    const alreadyListed = s.lastBlockedBundleId
      ? replyApps.some((a) => a.toLowerCase() === s.lastBlockedBundleId.toLowerCase())
      : true;
    if (s.lastBlockedBundleId && !alreadyListed) {
      btn.hidden = false;
      btn.textContent = `Aggiungi ${s.lastBlockedBundleId}`;
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
