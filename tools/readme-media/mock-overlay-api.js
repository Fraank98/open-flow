// Documentation-only snapshot of the real overlay renderer.
(() => {
  const q = new URLSearchParams(location.search);
  document.documentElement.style.colorScheme = q.get("theme") || "light";
  const callbacks = {};
  // Freeze the documentation clock so captures stay reproducible.
  window.setInterval = () => 0;
  window.openFlowOverlay = {
    onAppearance: cb => { callbacks.appearance = cb; },
    onLevel: cb => { callbacks.level = cb; },
    onState: cb => { callbacks.state = cb; },
    onPartial: cb => { callbacks.partial = cb; },
    onSuggestions: () => {}, onFlash: () => {},
    cancel: () => {}, choose: () => {}, dismiss: () => {}, hover: () => {},
  };
  document.addEventListener("DOMContentLoaded", () => {
    callbacks.appearance({ style: q.get("style") || "preview", shortcutLabel: "⌥ Option" });
    callbacks.state(q.get("state") || "recording");
    document.getElementById("elapsed").textContent = "00:12";
    callbacks.partial(q.get("partial") || "Let’s meet tomorrow to discuss the details.");
  });
})();
