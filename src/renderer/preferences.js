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

  const langSel = $("#language");
  for (const lang of catalog.languages) {
    const opt = document.createElement("option");
    opt.value = lang.id;
    opt.textContent = lang.label;
    if (lang.id === prefs.language) opt.selected = true;
    langSel.appendChild(opt);
  }

  // One idempotent renderer per row: it always rebuilds the actions cell from
  // the row state ({installed, selected, downloading}) and always attaches the
  // handlers, so a row can be re-rendered any number of times (row click,
  // delete, download finished) without leaving a dead button behind.
  function renderRow(row, m, ctx) {
    const selected = m.id === ctx.getSelectedId();
    row.classList.toggle("selected", selected);
    const badge = row.querySelector(".badge");
    badge.classList.toggle("installed", m.installed);
    badge.textContent = m.installed ? "installed" : "not installed";

    const actions = row.querySelector(".row-actions");
    actions.innerHTML = "";

    if (m.downloading) {
      const busy = document.createElement("button");
      busy.disabled = true;
      busy.textContent = (m.progressPct ?? 0) + "%";
      actions.appendChild(busy);
      return;
    }

    if (!m.installed) {
      const dlBtn = document.createElement("button");
      dlBtn.textContent = m.downloadFailed ? "Retry" : "Download";
      dlBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        m.downloading = true;
        m.downloadFailed = false;
        m.progressPct = 0;
        ctx.renderAll();
        const off = window.openFlowPrefs.onDownloadProgress((p) => {
          if (p.id === m.id && p.total > 0) {
            m.progressPct = Math.floor((p.bytes / p.total) * 100);
            renderRow(row, m, ctx);
          }
        });
        try {
          await window.openFlowPrefs.downloadModel(ctx.kind, m.id);
          m.installed = true;
          $("#status").textContent = `Downloaded ${m.label}. Click the row to select it, then Save.`;
        } catch (err) {
          m.downloadFailed = true;
          $("#status").textContent = "Download failed: " + err.message;
        } finally {
          off();
          m.downloading = false;
          ctx.renderAll();
        }
      });
      actions.appendChild(dlBtn);
      return;
    }

    // Installed. The active model can't be deleted, so it gets no action.
    if (!selected) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.className = "danger";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        delBtn.disabled = true;
        delBtn.textContent = "Deleting…";
        try {
          await window.openFlowPrefs.deleteModel(ctx.kind, m.id);
          m.installed = false;
          $("#status").textContent = `Deleted ${m.label}.`;
        } catch (err) {
          $("#status").textContent = "Delete failed: " + err.message;
        }
        ctx.renderAll();
      });
      actions.appendChild(delBtn);
    }
  }

  function renderModels(containerId, models, selectedId, kind) {
    const container = $("#" + containerId);
    container.innerHTML = "";
    const ctx = {
      kind,
      selectedId,
      getSelectedId: () => ctx.selectedId,
      renderAll: () => {
        for (const row of container.children) {
          const model = models.find((x) => x.id === row.dataset.id);
          if (model) renderRow(row, model, ctx);
        }
      },
    };
    for (const m of models) {
      const row = document.createElement("div");
      row.className = "model-row";
      row.dataset.id = m.id;

      const nameEl = document.createElement("span");
      nameEl.className = "name";
      nameEl.textContent = m.label;
      const sizeEl = document.createElement("span");
      sizeEl.className = "size";
      sizeEl.textContent = `${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB`;
      const badgeEl = document.createElement("span");
      badgeEl.className = "badge";
      const actionsEl = document.createElement("span");
      actionsEl.className = "row-actions";
      row.append(nameEl, sizeEl, badgeEl, actionsEl);

      row.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        if (!m.installed) {
          $("#status").textContent = "Download this model before selecting it.";
          return;
        }
        ctx.selectedId = m.id;
        ctx.renderAll();
        refreshSaveButton();
      });

      container.appendChild(row);
    }
    ctx.renderAll();
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
  // Model row selection calls refreshSaveButton() from its own click handler.
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
