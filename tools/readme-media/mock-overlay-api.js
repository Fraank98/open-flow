// Fake window.openFlowOverlay for previews. Query: ?state=recording|transcribing|cleaning|injecting|paste-failed|idle&partial=text
(function () {
  const q = new URLSearchParams(location.search);
  document.write("<style>*{animation:none!important;transition:none!important}</style>");
  const stateCbs = [], partialCbs = [];
  window.openFlowOverlay = {
    onState: (cb) => { stateCbs.push(cb); return () => {}; },
    onPartial: (cb) => { partialCbs.push(cb); return () => {}; },
    cancel: () => console.log("[mock] cancel"),
  };
  document.addEventListener("DOMContentLoaded", () => {
    const st = q.get("state") || "recording";
    stateCbs.forEach((cb) => cb(st));
    if (q.get("partial")) partialCbs.forEach((cb) => cb(q.get("partial")));
  });
})();
