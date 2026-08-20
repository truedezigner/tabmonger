(async () => {
  "use strict";

  const TM = globalThis.TabMongerExtension;
  const form = document.querySelector("#setup-form");
  const input = document.querySelector("#target-url");
  const enabled = document.querySelector("#enabled");
  const healthCheck = document.querySelector("#health-check");
  const saveButton = document.querySelector("#save");
  const testButton = document.querySelector("#test");
  const openButton = document.querySelector("#open");
  const clearButton = document.querySelector("#clear");
  const status = document.querySelector("#status");
  let config = { ...TM.DEFAULT_CONFIG };

  function showStatus(message, tone = "") {
    status.textContent = message;
    status.className = `status ${tone}`.trim();
  }

  function readTarget() {
    const normalized = TM.normalizeTarget(input.value);
    input.value = normalized;
    return normalized;
  }

  function setBusy(busy) {
    saveButton.disabled = busy;
    testButton.disabled = busy;
    clearButton.disabled = busy;
  }

  async function grantAndProbe(target) {
    const granted = await TM.requestHealthAccess(target);
    if (!granted) {
      return {
        granted: false,
        result: null,
        message: "Connection access was not granted. The address can still open directly, but the browser will show its own error page when the server is offline.",
      };
    }
    showStatus("Checking the local TabMonger address…");
    return { granted: true, result: await TM.probeTabMonger(target) };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    let target;
    try {
      target = readTarget();
    } catch (error) {
      showStatus(error.message, "error");
      input.focus();
      return;
    }

    setBusy(true);
    const oldPattern = config.permissionPattern;
    let checkEnabled = healthCheck.checked;
    let check = null;
    try {
      if (checkEnabled) {
        check = await grantAndProbe(target);
        checkEnabled = check.granted;
        healthCheck.checked = checkEnabled;
      }
      const nextPattern = checkEnabled ? TM.permissionPattern(target) : "";
      config = await TM.setConfig({
        targetUrl: target,
        enabled: enabled.checked,
        checkBeforeOpen: checkEnabled,
        permissionPattern: nextPattern,
      });
      if (oldPattern && oldPattern !== nextPattern) {
        await TM.dropHealthAccess(oldPattern);
      }

      if (!enabled.checked) {
        showStatus("Address saved. TabMonger is paused for new tabs.", "success");
      } else if (check && !check.granted) {
        showStatus(`Saved in direct-open mode. ${check.message}`, "warning");
      } else if (check && check.result && check.result.ok) {
        showStatus(`Saved. ${check.result.message} New tabs are ready.`, "success");
      } else if (check && check.result) {
        showStatus(`Saved, but it is offline right now. ${check.result.message}`, "warning");
      } else {
        showStatus("Saved. New tabs will open TabMonger directly.", "success");
      }
    } catch (error) {
      showStatus(`Could not save the setup: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  });

  testButton.addEventListener("click", async () => {
    let target;
    try {
      target = readTarget();
    } catch (error) {
      showStatus(error.message, "error");
      input.focus();
      return;
    }
    setBusy(true);
    let temporaryPattern = "";
    try {
      temporaryPattern = TM.permissionPattern(target);
      const check = await grantAndProbe(target);
      if (!check.granted) {
        showStatus(check.message, "warning");
      } else if (check.result.ok) {
        showStatus(check.result.message, "success");
      } else {
        showStatus(check.result.message, "warning");
      }
    } catch (error) {
      showStatus(`Could not check the address: ${error.message}`, "error");
    } finally {
      if (temporaryPattern && temporaryPattern !== config.permissionPattern) {
        await TM.dropHealthAccess(temporaryPattern);
      }
      setBusy(false);
    }
  });

  openButton.addEventListener("click", () => {
    try {
      globalThis.open(readTarget(), "_blank", "noopener");
    } catch (error) {
      showStatus(error.message, "error");
      input.focus();
    }
  });

  clearButton.addEventListener("click", async () => {
    if (!globalThis.confirm("Clear the saved TabMonger address and extension choices?")) {
      return;
    }
    setBusy(true);
    try {
      if (config.permissionPattern) {
        await TM.dropHealthAccess(config.permissionPattern);
      }
      await TM.clearConfig();
      config = { ...TM.DEFAULT_CONFIG };
      input.value = "";
      enabled.checked = true;
      healthCheck.checked = true;
      showStatus("Setup cleared. Your TabMonger server and its data were not changed.", "success");
      input.focus();
    } catch (error) {
      showStatus(`Could not clear setup: ${error.message}`, "error");
    } finally {
      setBusy(false);
    }
  });

  try {
    config = await TM.getConfig();
    input.value = config.targetUrl || "";
    enabled.checked = config.enabled;
    healthCheck.checked = config.checkBeforeOpen;
    if (config.targetUrl) {
      const access = config.checkBeforeOpen && await TM.hasHealthAccess(config.targetUrl);
      showStatus(access
        ? "Setup loaded. Friendly offline checking is active for this hostname."
        : "Setup loaded. New tabs open the saved address directly.");
    }
  } catch (error) {
    showStatus(`Could not load the saved setup: ${error.message}`, "error");
  }
})();
