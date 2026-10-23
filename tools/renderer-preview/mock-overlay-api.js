// Local preview only: controls drive the real overlay renderer without a mic.
(() => {
  const q = new URLSearchParams(location.search);
  if (q.get("theme")) document.documentElement.style.colorScheme = q.get("theme");
  const handlers = {};
  window.openFlowOverlay = {
    onAppearance: (cb) => { handlers.appearance = cb; },
    onLevel: (cb) => { handlers.level = cb; },
    onState: (cb) => { handlers.state = cb; },
    onPartial: (cb) => { handlers.partial = cb; },
    onFlash: (cb) => { handlers.flash = cb; },
    onSuggestions: (cb) => { handlers.suggestions = cb; },
    cancel: () => handlers.state("idle"),
    choose: () => handlers.state("idle"),
    dismiss: () => handlers.state("idle"),
    hover: () => {},
  };
  window.addEventListener("DOMContentLoaded", () => {
    const controls = document.createElement("div");
    controls.style.cssText = "position:absolute;top:16px;left:16px;display:flex;gap:8px;font:13px system-ui";
    for (const style of ["compact", "preview", "minimal"]) {
      const button = document.createElement("button");
      button.textContent = style;
      button.onclick = () => handlers.appearance({ style, shortcutLabel: "⌃ Control" });
      controls.append(button);
    }
    for (const state of ["recording", "transcribing", "paste-failed", "thinking"]) {
      const button = document.createElement("button");
      button.textContent = state;
      button.onclick = () => {
        handlers.state(state);
        if (state === "recording") handlers.partial("Let’s meet tomorrow to discuss the details.");
      };
      controls.append(button);
    }
    document.body.append(controls);
    handlers.appearance({ style: q.get("style") || "compact", shortcutLabel: "⌃ Control" });
    handlers.state("recording");
    handlers.partial("Let’s meet tomorrow to discuss the details.");
  });
})();
