(function attachTabMongerExtension(root, factory) {
  const helpers = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  } else {
    root.TabMongerExtension = helpers;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    targetUrl: "",
    enabled: true,
    checkBeforeOpen: true,
    permissionPattern: "",
  });

  function extensionApi() {
    return root.browser || root.chrome || null;
  }

  function usesPromiseApi() {
    return Boolean(root.browser);
  }

  function apiCall(owner, method, args = []) {
    const api = extensionApi();
    if (!api || !owner || typeof owner[method] !== "function") {
      return Promise.reject(new Error("Browser extension API is unavailable."));
    }

    if (usesPromiseApi()) {
      try {
        return Promise.resolve(owner[method](...args));
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise((resolve, reject) => {
      owner[method](...args, (result) => {
        const lastError = api.runtime && api.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function isPrivateHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".lan")) {
      return true;
    }
    if (!host.includes(".")) {
      return true;
    }
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return octets[0] === 10
        || octets[0] === 127
        || (octets[0] === 169 && octets[1] === 254)
        || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168);
    }
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
  }

  function guessScheme(value) {
    const authority = value.split(/[/?#]/, 1)[0];
    let host = authority;
    if (host.startsWith("[")) {
      host = host.slice(1, host.indexOf("]"));
    } else if ((host.match(/:/g) || []).length <= 1) {
      host = host.split(":", 1)[0];
    }
    return isPrivateHost(host) ? "http://" : "https://";
  }

  function normalizeTarget(value) {
    let input = String(value || "").trim();
    if (!input) {
      throw new Error("Enter the address shown by TabMonger.");
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
      input = guessScheme(input) + input;
    }

    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new Error("Use a complete web address, such as http://192.168.1.20:8787/.");
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error("Only http:// and https:// TabMonger addresses are supported.");
    }
    if (parsed.username || parsed.password) {
      throw new Error("For safety, do not put usernames, passwords, or tokens in the address.");
    }

    // A TabMonger base address never needs URL credentials, a query, or a fragment.
    // Dropping the latter two also prevents accidental storage of token-like values.
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  }

  function permissionPattern(value) {
    const parsed = new URL(normalizeTarget(value));
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  function healthUrl(value) {
    const parsed = new URL(normalizeTarget(value));
    if (!parsed.pathname.endsWith("/")) {
      parsed.pathname += "/";
    }
    parsed.pathname += "api/health";
    return parsed.href;
  }

  function displayTarget(value) {
    const parsed = new URL(normalizeTarget(value));
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}`;
  }

  async function getConfig() {
    const api = extensionApi();
    if (!api) {
      return { ...DEFAULT_CONFIG };
    }
    const saved = await apiCall(api.storage.local, "get", [DEFAULT_CONFIG]);
    return { ...DEFAULT_CONFIG, ...(saved || {}) };
  }

  async function setConfig(config) {
    const api = extensionApi();
    const next = {
      ...DEFAULT_CONFIG,
      ...config,
      enabled: Boolean(config.enabled),
      checkBeforeOpen: Boolean(config.checkBeforeOpen),
    };
    await apiCall(api.storage.local, "set", [next]);
    return next;
  }

  async function clearConfig() {
    const api = extensionApi();
    await apiCall(api.storage.local, "clear");
  }

  async function hasHealthAccess(value) {
    const api = extensionApi();
    if (!api || !api.permissions) {
      return false;
    }
    return Boolean(await apiCall(api.permissions, "contains", [{ origins: [permissionPattern(value)] }]));
  }

  async function requestHealthAccess(value) {
    const api = extensionApi();
    if (!api || !api.permissions) {
      return false;
    }
    return Boolean(await apiCall(api.permissions, "request", [{ origins: [permissionPattern(value)] }]));
  }

  async function dropHealthAccess(pattern) {
    const api = extensionApi();
    if (!api || !api.permissions || !pattern) {
      return false;
    }
    try {
      return Boolean(await apiCall(api.permissions, "remove", [{ origins: [pattern] }]));
    } catch {
      return false;
    }
  }

  async function openOptions() {
    const api = extensionApi();
    return apiCall(api.runtime, "openOptionsPage");
  }

  async function fetchWithTimeout(url, timeoutMs, mode = "cors") {
    const controller = new AbortController();
    const timer = root.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await root.fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        mode,
        signal: controller.signal,
      });
    } finally {
      root.clearTimeout(timer);
    }
  }

  async function reachableResponse(url, timeoutMs) {
    try {
      return await fetchWithTimeout(url, timeoutMs, "cors");
    } catch (firstError) {
      if (firstError && firstError.name === "AbortError") {
        throw firstError;
      }
      return fetchWithTimeout(url, timeoutMs, "no-cors");
    }
  }

  async function probeTabMonger(value, timeoutMs = 1800) {
    const target = normalizeTarget(value);
    try {
      const health = await reachableResponse(healthUrl(target), timeoutMs);
      if (health.type === "opaque") {
        return { ok: true, verified: false, message: "The address answered." };
      }
      if (health.status === 401) {
        return { ok: true, verified: false, message: "The address answered and requires sign-in." };
      }
      if (health.status === 403) {
        return { ok: true, verified: false, message: "The address answered; health details are restricted." };
      }
      if (health.ok) {
        try {
          const payload = await health.clone().json();
          if (payload && (payload.ok === true || payload.name === "TabMonger")) {
            return { ok: true, verified: true, message: "TabMonger is online." };
          }
        } catch {
          // A reachable reverse proxy may not expose the JSON health route.
        }
        return { ok: true, verified: false, message: "The address answered." };
      }
      if (health.status !== 404) {
        return { ok: false, verified: false, message: `The server answered with status ${health.status}.` };
      }

      const page = await reachableResponse(target, timeoutMs);
      if (page.type === "opaque" || page.ok || page.status === 401 || page.status === 403) {
        return { ok: true, verified: false, message: "The address is online." };
      }
      return { ok: false, verified: false, message: `The server answered with status ${page.status}.` };
    } catch (error) {
      const timedOut = error && error.name === "AbortError";
      return {
        ok: false,
        verified: false,
        message: timedOut
          ? "The connection timed out. Check that TabMonger is running and this device is on the same network."
          : "TabMonger did not answer. Check that it is running and this device is on the same network.",
      };
    }
  }

  return Object.freeze({
    DEFAULT_CONFIG,
    normalizeTarget,
    permissionPattern,
    healthUrl,
    displayTarget,
    getConfig,
    setConfig,
    clearConfig,
    hasHealthAccess,
    requestHealthAccess,
    dropHealthAccess,
    openOptions,
    probeTabMonger,
  });
});
