"use strict";

const $ = (sel) => document.querySelector(sel);

async function init() {
  const prefs = await window.openFlowPrefs.load();
  const catalog = await window.openFlowPrefs.listModels();

  $("#hotkey").value = prefs.hotkeyAccelerator;
  $("#debug").checked = prefs.debugLogging;
  $("#cleanup").checked = prefs.useLlmCleanup !== false;

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
      const sizeMb = (m.sizeBytes / 1024 / 1024).toFixed(0);
      row.innerHTML = `
        <span class="name">${m.label}</span>
        <span class="size">${sizeMb} MB</span>
        <span class="badge ${m.installed ? "installed" : ""}">${m.installed ? "installed" : "not installed"}</span>
      `;
      if (!m.installed) {
        const btn = document.createElement("button");
        btn.textContent = "Download";
        btn.addEventListener("click", async () => {
          btn.textContent = "0%";
          btn.disabled = true;
          const off = window.openFlowPrefs.onDownloadProgress((p) => {
            if (p.id === m.id && p.total > 0) {
              btn.textContent = Math.floor((p.bytes / p.total) * 100) + "%";
            }
          });
          try {
            await window.openFlowPrefs.downloadModel(kind, m.id);
            btn.remove();
            row.querySelector(".badge").classList.add("installed");
            row.querySelector(".badge").textContent = "installed";
          } catch (err) {
            btn.textContent = "Retry";
            btn.disabled = false;
            $("#status").textContent = "Download failed: " + err.message;
          } finally {
            off();
          }
        });
        row.appendChild(btn);
      }
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON") return;
        if (!m.installed) {
          $("#status").textContent = "Download this model before selecting it.";
          return;
        }
        Array.from(container.children).forEach((c) => c.classList.remove("selected"));
        row.classList.add("selected");
        row.dataset.selected = "true";
      });
      row.dataset.id = m.id;
      container.appendChild(row);
    }
  }

  renderModels("whisper-models", catalog.whisper, prefs.whisperModelId, "whisper");
  renderModels("llm-models", catalog.llm, prefs.llmModelId, "llm");

  $("#save").addEventListener("click", async () => {
    const selectedWhisper = $("#whisper-models .selected")?.dataset.id ?? prefs.whisperModelId;
    const selectedLlm = $("#llm-models .selected")?.dataset.id ?? prefs.llmModelId;
    const next = {
      ...prefs,
      hotkeyAccelerator: $("#hotkey").value.trim() || prefs.hotkeyAccelerator,
      language: langSel.value,
      whisperModelId: selectedWhisper,
      llmModelId: selectedLlm,
      debugLogging: $("#debug").checked,
      useLlmCleanup: $("#cleanup").checked,
    };
    await window.openFlowPrefs.save(next);
    $("#status").textContent = "Saved. Restart the app for hotkey/model changes to take effect.";
  });
}

init();
