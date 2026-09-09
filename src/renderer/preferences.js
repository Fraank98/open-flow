"use strict";

const $ = (sel) => document.querySelector(sel);

// Fields that the running main-process can't pick up without a relaunch:
// the hotkey accelerator is registered once at startup, Whisper / LLM models
// are loaded into their respective servers at boot, and the llama-server is
// only started at launch when LLM cleanup is enabled — so toggling cleanup
// must restart too (turning it on at runtime otherwise falls back to raw
// text until the next launch). Changes to any of these flip the Save button
// into "Save & Restart".
// hotkeyAccelerator is not user-configurable yet (PTT is hardcoded to
// Option in the native addon), so it never triggers a restart.
// Reply suggestions fields (replySuggestionsEnabled, replySuggestionsHotkey,
// replyModelId, replyAppsMode, replyApps, userDisplayName) never enter this
// list: the second llama-server is reconciled by ReplyServerManager.apply
// at save time, the hotkey is re-registered by applyReplyHotkey, and the
// name/apps/mode are read fresh from disk on every hotkey press — none of
// them needs a relaunch.
const RESTART_REQUIRED_FIELDS = ["whisperModelId", "llmModelId", "useLlmCleanup"];

async function init() {
  const prefs = await window.openFlowPrefs.load();
  const initialPrefs = { ...prefs };
  const catalog = await window.openFlowPrefs.listModels();

  // Hotkey input is read-only (display only). The PTTManager uses the
  // native addon's Option monitor, not Electron's globalShortcut.
  $("#hotkey").value = "Hold Option";
  $("#debug").checked = prefs.debugLogging;
  $("#cleanup").checked = prefs.useLlmCleanup !== false;
  $("#launchAtLogin").checked = prefs.launchAtLogin !== false;
  $("#spokenPunctuation").checked = prefs.spokenPunctuation === true;

  // Working copy of the dictionary terms; rendered as a removable list.
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
      rm.className = "danger";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${term}`);
      rm.addEventListener("click", () => {
        dictTerms.splice(i, 1);
        renderDict();
        refreshSaveButton();
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
    refreshSaveButton();
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
  $("#replyHotkey").value = prefs.replySuggestionsHotkey ?? "Command+Control+R";
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
  $("#replyAppsMode").addEventListener("change", updateReplyAppsModeUI);

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
      rm.addEventListener("click", () => { replyApps.splice(i, 1); renderReplyApps(); });
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
            $("#status").textContent = `Scaricato ${t.label}. Seleziona il tier e salva.`;
            // This is the primary path to turning the feature on: without
            // this the checkbox stays disabled, with no explanation, until
            // something unrelated (a name edit, a tier click) happens to
            // re-run the guard.
            refreshReplyGuards();
          } catch (err) {
            dl.disabled = false;
            dl.textContent = "Retry";
            $("#status").textContent = "Download failed: " + err.message;
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
    $("#save").disabled = !r.ok && $("#replyEnabled").checked;
    return r.ok;
  }
  $("#replyHotkey").addEventListener("input", () => { void validateHotkeyField(); });

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
    box.disabled = blockers.length > 0;
    if (blockers.length > 0) {
      $("#status").textContent = `Per accendere le proposte di risposta: ${blockers.join(", ")}.`;
    }
    // The checkbox's checked state is one of the two inputs to the Save
    // gate above, so a guard refresh (which can follow a checkbox change)
    // must recompute it too.
    void validateHotkeyField();
  }
  $("#userDisplayName").addEventListener("input", refreshReplyGuards);
  $("#replyEnabled").addEventListener("change", refreshReplyGuards);
  refreshReplyGuards();

  async function refreshReplyStatus() {
    const s = await window.openFlowPrefs.replyStatus();
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

  const langSel = $("#language");
  for (const lang of catalog.languages) {
    const opt = document.createElement("option");
    opt.value = lang.id;
    opt.textContent = lang.label;
    if (lang.id === prefs.language) opt.selected = true;
    langSel.appendChild(opt);
  }

  function renderModels(containerId, models, selectedId, kind) {
    const container = $("#" + containerId);
    container.innerHTML = "";
    for (const m of models) {
      const row = document.createElement("div");
      row.className = "model-row" + (m.id === selectedId ? " selected" : "");
      row.dataset.id = m.id;

      const nameEl = document.createElement("span");
      nameEl.className = "name";
      nameEl.textContent = m.label;
      const sizeEl = document.createElement("span");
      sizeEl.className = "size";
      sizeEl.textContent = `${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB`;
      const badgeEl = document.createElement("span");
      badgeEl.className = "badge" + (m.installed ? " installed" : "");
      badgeEl.textContent = m.installed ? "installed" : "not installed";
      row.append(nameEl, sizeEl, badgeEl);

      const actionsEl = document.createElement("span");
      actionsEl.className = "row-actions";
      row.appendChild(actionsEl);

      function getCurrentlySelected() {
        return $(`#${containerId} .selected`)?.dataset.id;
      }

      function setInstalled(installed) {
        m.installed = installed;
        badgeEl.classList.toggle("installed", installed);
        badgeEl.textContent = installed ? "installed" : "not installed";
        actionsEl.innerHTML = "";
        if (installed) {
          if (m.id !== getCurrentlySelected()) {
            const delBtn = document.createElement("button");
            delBtn.textContent = "Delete";
            delBtn.className = "danger";
            delBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              if (m.id === getCurrentlySelected()) {
                $("#status").textContent = "Switch to another model + Save first, then delete this one.";
                return;
              }
              delBtn.disabled = true;
              delBtn.textContent = "Deleting…";
              try {
                await window.openFlowPrefs.deleteModel(kind, m.id);
                setInstalled(false);
                $("#status").textContent = `Deleted ${m.label}.`;
              } catch (err) {
                $("#status").textContent = "Delete failed: " + err.message;
                delBtn.disabled = false;
                delBtn.textContent = "Delete";
              }
            });
            actionsEl.appendChild(delBtn);
          }
        } else {
          const dlBtn = document.createElement("button");
          dlBtn.textContent = "Download";
          dlBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            dlBtn.textContent = "0%";
            dlBtn.disabled = true;
            const off = window.openFlowPrefs.onDownloadProgress((p) => {
              if (p.id === m.id && p.total > 0) {
                dlBtn.textContent = Math.floor((p.bytes / p.total) * 100) + "%";
              }
            });
            try {
              await window.openFlowPrefs.downloadModel(kind, m.id);
              setInstalled(true);
              $("#status").textContent = `Downloaded ${m.label}. Click the row to select it, then Save.`;
            } catch (err) {
              dlBtn.textContent = "Retry";
              dlBtn.disabled = false;
              $("#status").textContent = "Download failed: " + err.message;
            } finally {
              off();
            }
          });
          actionsEl.appendChild(dlBtn);
        }
      }

      setInstalled(m.installed);

      row.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        if (!m.installed) {
          $("#status").textContent = "Download this model before selecting it.";
          return;
        }
        Array.from(container.children).forEach((c) => c.classList.remove("selected"));
        row.classList.add("selected");
        // Re-render Delete buttons: the row that just became selected must
        // hide its Delete (you can't delete the active model), and others
        // that are installed should show Delete again.
        for (const r of container.children) {
          const id = r.dataset.id;
          const inst = id === m.id ? true : models.find((x) => x.id === id)?.installed;
          const model = models.find((x) => x.id === id);
          if (!model) continue;
          // Reuse setInstalled-equivalent by re-rendering the actions cell only
          const actionsCell = r.querySelector(".row-actions");
          if (!actionsCell) continue;
          actionsCell.innerHTML = "";
          if (inst && id !== m.id) {
            const delBtn = document.createElement("button");
            delBtn.textContent = "Delete";
            delBtn.className = "danger";
            delBtn.addEventListener("click", async (ev) => {
              ev.stopPropagation();
              if (id === getCurrentlySelected()) {
                $("#status").textContent = "Switch to another model + Save first, then delete this one.";
                return;
              }
              delBtn.disabled = true;
              delBtn.textContent = "Deleting…";
              try {
                await window.openFlowPrefs.deleteModel(kind, id);
                model.installed = false;
                const badge = r.querySelector(".badge");
                badge.classList.remove("installed");
                badge.textContent = "not installed";
                actionsCell.innerHTML = "";
                const dl = document.createElement("button");
                dl.textContent = "Download";
                actionsCell.appendChild(dl);
                $("#status").textContent = `Deleted ${model.label}.`;
              } catch (err) {
                $("#status").textContent = "Delete failed: " + err.message;
                delBtn.disabled = false;
                delBtn.textContent = "Delete";
              }
            });
            actionsCell.appendChild(delBtn);
          } else if (!inst) {
            const dl = document.createElement("button");
            dl.textContent = "Download";
            actionsCell.appendChild(dl);
          }
        }
      });

      container.appendChild(row);
    }
  }

  renderModels("whisper-models", catalog.whisper, prefs.whisperModelId, "whisper");
  renderModels("llm-models", catalog.llm, prefs.llmModelId, "llm");

  function buildNextPrefs() {
    const selectedWhisper = $("#whisper-models .selected")?.dataset.id ?? prefs.whisperModelId;
    const selectedLlm = $("#llm-models .selected")?.dataset.id ?? prefs.llmModelId;
    return {
      ...prefs,
      // hotkeyAccelerator is fixed in this build; preserve whatever was
      // already saved instead of writing the read-only display string.
      hotkeyAccelerator: prefs.hotkeyAccelerator,
      language: langSel.value,
      whisperModelId: selectedWhisper,
      llmModelId: selectedLlm,
      debugLogging: $("#debug").checked,
      useLlmCleanup: $("#cleanup").checked,
      launchAtLogin: $("#launchAtLogin").checked,
      spokenPunctuation: $("#spokenPunctuation").checked,
      dictionary: dictTerms,
      userDisplayName: $("#userDisplayName").value.trim(),
      replySuggestionsEnabled: $("#replyEnabled").checked,
      replySuggestionsHotkey: $("#replyHotkey").value.trim(),
      replyModelId: selectedTier().modelId,
      replyAppsMode: $("#replyAppsMode").value,
      replyApps,
    };
  }

  function needsRestart() {
    const next = buildNextPrefs();
    return RESTART_REQUIRED_FIELDS.some((k) => next[k] !== initialPrefs[k]);
  }

  function refreshSaveButton() {
    $("#save").textContent = needsRestart() ? "Save & Restart" : "Save";
  }

  // Update the button label live as the user changes inputs.
  // hotkey input is read-only so we skip it.
  for (const el of [
    $("#language"),
    $("#debug"),
    $("#cleanup"),
    $("#launchAtLogin"),
    $("#spokenPunctuation"),
  ]) {
    el.addEventListener("input", refreshSaveButton);
    el.addEventListener("change", refreshSaveButton);
  }
  // Selection changes on model rows propagate via click handler; also
  // refresh on a generic document click as a cheap catch-all.
  document.addEventListener("click", refreshSaveButton);
  refreshSaveButton();

  $("#save").addEventListener("click", async () => {
    const next = buildNextPrefs();
    const shouldRestart = needsRestart();
    await window.openFlowPrefs.save(next);
    if (shouldRestart) {
      $("#status").textContent = "Saved. Restarting…";
      window.openFlowPrefs.relaunch();
    } else {
      $("#status").textContent = "Saved.";
    }
  });
}

init();
