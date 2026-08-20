#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const commonSource = await readFile(resolve(scriptDir, "../source/common.js"), "utf8");

function baseContext() {
  return {
    URL,
    AbortController,
    Response,
    setTimeout,
    clearTimeout,
    fetch: async () => new Response(JSON.stringify({ ok: true, name: "TabMonger" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  };
}

function chromeMock() {
  let saved = {};
  const granted = new Set();
  const chrome = {
    runtime: {
      lastError: null,
      openOptionsPage(callback) { callback(); },
    },
    storage: {
      local: {
        get(defaults, callback) { callback({ ...defaults, ...saved }); },
        set(next, callback) { saved = { ...saved, ...next }; callback(); },
        clear(callback) { saved = {}; callback(); },
      },
    },
    permissions: {
      contains(details, callback) { callback(details.origins.every((origin) => granted.has(origin))); },
      request(details, callback) { details.origins.forEach((origin) => granted.add(origin)); callback(true); },
      remove(details, callback) { details.origins.forEach((origin) => granted.delete(origin)); callback(true); },
    },
  };
  return chrome;
}

function firefoxMock() {
  let saved = {};
  const granted = new Set();
  return {
    runtime: { async openOptionsPage() {} },
    storage: {
      local: {
        async get(defaults) { return { ...defaults, ...saved }; },
        async set(next) { saved = { ...saved, ...next }; },
        async clear() { saved = {}; },
      },
    },
    permissions: {
      async contains(details) { return details.origins.every((origin) => granted.has(origin)); },
      async request(details) { details.origins.forEach((origin) => granted.add(origin)); return true; },
      async remove(details) { details.origins.forEach((origin) => granted.delete(origin)); return true; },
    },
  };
}

async function exercise(apiName, api) {
  const context = vm.createContext({ ...baseContext(), [apiName]: api });
  vm.runInContext(commonSource, context, { filename: "common.js" });
  const TM = context.TabMongerExtension;
  const target = "http://192.168.1.20:8787/";

  assert.equal((await TM.getConfig()).targetUrl, "");
  await TM.setConfig({ targetUrl: target, enabled: true, checkBeforeOpen: true });
  assert.equal((await TM.getConfig()).targetUrl, target);
  assert.equal(await TM.hasHealthAccess(target), false);
  assert.equal(await TM.requestHealthAccess(target), true);
  assert.equal(await TM.hasHealthAccess(target), true);
  assert.equal((await TM.probeTabMonger(target)).verified, true);
  assert.equal(await TM.dropHealthAccess(TM.permissionPattern(target)), true);
  assert.equal(await TM.hasHealthAccess(target), false);
  await TM.openOptions();
  await TM.clearConfig();
  assert.equal((await TM.getConfig()).targetUrl, "");
}

await exercise("chrome", chromeMock());
await exercise("browser", firefoxMock());

const restrictedContext = vm.createContext({
  ...baseContext(),
  chrome: chromeMock(),
  fetch: async () => new Response("Forbidden", { status: 403 }),
});
vm.runInContext(commonSource, restrictedContext, { filename: "common.js" });
const restricted = await restrictedContext.TabMongerExtension.probeTabMonger("http://192.168.1.20:8787/");
assert.equal(restricted.ok, true);
assert.equal(restricted.verified, false);
assert.match(restricted.message, /health details are restricted/i);

console.log("Passed shared runtime tests against Chromium callback APIs, Firefox promise APIs, and restricted health responses.");
