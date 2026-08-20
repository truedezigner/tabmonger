(async () => {
  "use strict";

  const TM = globalThis.TabMongerExtension;
  const mark = document.querySelector("#state-mark");
  const title = document.querySelector("#state-title");
  const message = document.querySelector("#state-message");
  const target = document.querySelector("#target");
  const actions = document.querySelector("#actions");
  const finePrint = document.querySelector("#fine-print");
  let config = { ...TM.DEFAULT_CONFIG };
  let normalized = "";

  function render({ mode, heading, body, showTarget = false, buttons = [] }) {
    mark.className = `state-mark ${mode}`;
    title.textContent = heading;
    message.textContent = body;
    target.hidden = !showTarget;
    target.textContent = showTarget && normalized ? TM.displayTarget(normalized) : "";
    actions.hidden = buttons.length === 0;
    actions.querySelectorAll("button").forEach((button) => {
      button.hidden = !buttons.includes(button.dataset.action);
      button.disabled = false;
    });
  }

  function navigate() {
    globalThis.location.replace(normalized);
  }

  async function openConfiguredTarget() {
    render({
      mode: "waiting",
      heading: "Opening your dashboard",
      body: "Checking the TabMonger computer on your network.",
      showTarget: true,
    });

    let canCheck = false;
    if (config.checkBeforeOpen) {
      try {
        canCheck = await TM.hasHealthAccess(normalized);
      } catch {
        canCheck = false;
      }
    }
    if (!config.checkBeforeOpen || !canCheck) {
      navigate();
      return;
    }

    const result = await TM.probeTabMonger(normalized);
    if (result.ok) {
      navigate();
      return;
    }
    render({
      mode: "offline",
      heading: "TabMonger looks offline",
      body: result.message,
      showTarget: true,
      buttons: ["retry", "open-once", "settings"],
    });
    finePrint.textContent = "Nothing was sent anywhere else. You can retry after starting TabMonger.";
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "settings") {
      await TM.openOptions();
      return;
    }
    if (button.dataset.action === "open-once") {
      navigate();
      return;
    }
    if (button.dataset.action === "retry") {
      button.disabled = true;
      await openConfiguredTarget();
      return;
    }
    if (button.dataset.action === "resume") {
      config = await TM.setConfig({ ...config, enabled: true });
      await openConfiguredTarget();
    }
  });

  try {
    config = await TM.getConfig();
    normalized = TM.normalizeTarget(config.targetUrl);
  } catch {
    normalized = "";
  }

  if (!normalized) {
    render({
      mode: "paused",
      heading: "Connect this browser",
      body: "Add the local address shown by TabMonger. New tabs will then open the same shared dashboard on this network.",
      buttons: ["settings"],
    });
    const settingsButton = actions.querySelector('[data-action="settings"]');
    settingsButton.textContent = "Set up TabMonger";
    settingsButton.classList.remove("quiet");
    settingsButton.classList.add("primary");
    finePrint.textContent = "Private LAN addresses such as http://192.168.1.20:8787/ are supported.";
    return;
  }

  if (!config.enabled) {
    render({
      mode: "paused",
      heading: "New-tab opening is paused",
      body: "Your TabMonger address is still saved. Resume when you want new tabs to open it again.",
      showTarget: true,
      buttons: ["resume", "open-once", "settings"],
    });
    finePrint.textContent = "Removing or disabling the extension restores the browser's regular new-tab page.";
    return;
  }

  await openConfiguredTarget();
})();
