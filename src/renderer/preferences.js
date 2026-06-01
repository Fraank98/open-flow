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
