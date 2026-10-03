// Pure helpers for the setup wizard. Loaded as a plain script in the browser
// (globalThis.OpenFlowSetupLogic) and imported for its side effect in vitest.
(function (root, factory) { root.OpenFlowSetupLogic = factory(); })(globalThis, function () {
  "use strict";

  /** Badge text and css class for a permission status. */
  function permissionBadge(status) {
    if (status === "granted") return { text: "Granted", cls: "granted" };
    if (status === "denied") return { text: "Denied — fix in System Settings", cls: "denied" };
    return { text: "Not asked yet", cls: "pending" };
  }

  /** Continue is enabled only when microphone, Accessibility and Automation are all granted. */
  function canContinuePermissions(state) {
    return (
      !!state &&
      state.micPermission === "granted" &&
      state.accessibilityPermission === "granted" &&
      state.automationPermission === "granted"
    );
  }

  return { permissionBadge, canContinuePermissions };
});
