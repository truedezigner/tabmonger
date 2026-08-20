(async () => {
  "use strict";

  const TM = globalThis.TabMongerExtension;
  const title = document.querySelector("#popup-title");
  const message = document.querySelector("#popup-message");
  const target = document.querySelector("#popup-target");
  const toggleRow = document.querySelector("#popup-toggle-row");
  const enabled = document.querySelector("#popup-enabled");
  const openButton = document.querySelector("#popup-open");
  const settingsButton = document.querySelector("#popup-settings");
  let config = { ...TM.DEFAULT_CONFIG };
  let normalized = "";

  settingsButton.addEventListener("click", async () => {
    await TM.openOptions();
    globalThis.close();
  });

  openButton.addEventListener("click", () => {
    if (normalized) {
      globalThis.open(normalized, "_blank", "noopener");
    }
  });

  enabled.addEventListener("change", async () => {
    config = await TM.setConfig({ ...config, enabled: enabled.checked });
    title.textContent = enabled.checked ? "Connected to TabMonger" : "New-tab opening is paused";
    message.textContent = enabled.checked
      ? "New tabs will open your shared dashboard."
      : "The address is saved and can be resumed here.";
  });

  try {
    config = await TM.getConfig();
    normalized = TM.normalizeTarget(config.targetUrl);
    title.textContent = config.enabled ? "Connected to TabMonger" : "New-tab opening is paused";
    message.textContent = config.enabled
      ? "New tabs will open your shared dashboard."
      : "The address is saved and can be resumed here.";
    target.textContent = TM.displayTarget(normalized);
    target.hidden = false;
    toggleRow.hidden = false;
    enabled.checked = config.enabled;
    openButton.disabled = false;
  } catch {
    title.textContent = "Connect this browser";
    message.textContent = "Open settings and add the local address shown by TabMonger.";
    openButton.hidden = true;
    settingsButton.classList.add("primary");
  }
})();
