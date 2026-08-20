#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(scriptDir, "..");
const sourceDir = join(extensionDir, "source");
const packageDirs = ["chromium", "firefox"];
const expectedSizes = [16, 32, 48, 128];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await filesBelow(path));
    } else if (entry.isFile()) {
      output.push(path);
    }
  }
  return output.sort();
}

async function assertExists(path) {
  const details = await stat(path);
  assert(details.isFile(), `${path} must be a file`);
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "invalid PNG signature");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

const sourceFiles = (await filesBelow(sourceDir)).map((path) => relative(sourceDir, path));
assert(sourceFiles.length >= 12, "shared source appears incomplete");

for (const packageName of packageDirs) {
  const packageDir = join(extensionDir, packageName);
  const manifestPath = join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packagedFiles = (await filesBelow(packageDir)).map((path) => relative(packageDir, path));
  assert.deepEqual(packagedFiles, [...sourceFiles, "manifest.json"].sort(), `${packageName} contains stale or missing package files`);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"], `${packageName} must keep required permissions minimal`);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.chrome_url_overrides.newtab, "newtab.html");
  assert.equal(manifest.options_ui.page, "options.html");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.match(manifest.content_security_policy.extension_pages, /default-src 'self'/);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src http: https:/);
  assert.match(manifest.content_security_policy.extension_pages, /object-src 'none'/);
  if (packageName === "firefox") {
    assert.equal(manifest.browser_specific_settings.gecko.id, "newtab@tabmonger.com");
  } else {
    assert.equal(manifest.browser_specific_settings, undefined);
  }

  for (const relativePath of sourceFiles) {
    const source = await readFile(join(sourceDir, relativePath));
    const packaged = await readFile(join(packageDir, relativePath));
    assert(source.equals(packaged), `${packageName}/${relativePath} is out of sync; run node scripts/sync.mjs`);
  }

  for (const page of ["newtab.html", "options.html", "popup.html"]) {
    const html = await readFile(join(packageDir, page), "utf8");
    assert(!/<script(?!\s+src=)[^>]*>/i.test(html), `${page} contains inline JavaScript`);
    assert(!/(?:src|href)=["']https?:\/\//i.test(html), `${page} loads a remote asset`);
    assert(!/\sstyle=["']/i.test(html), `${page} contains an inline style`);
  }

  const code = await Promise.all(["common.js", "newtab.js", "options.js", "popup.js"].map((name) => readFile(join(packageDir, name), "utf8")));
  const joinedCode = code.join("\n");
  assert(!/\beval\s*\(|\bnew\s+Function\b/.test(joinedCode), "dynamic code execution is forbidden");
  assert(!/sk_(?:live|test)_|pk_(?:live|test)_/i.test(joinedCode), "a payment key appears in extension code");

  for (const size of expectedSizes) {
    const iconPath = join(packageDir, `icons/icon-${size}.png`);
    await assertExists(iconPath);
    const dimensions = pngDimensions(await readFile(iconPath));
    assert.deepEqual(dimensions, [size, size], `${iconPath} has the wrong dimensions`);
  }
}

const common = require(join(sourceDir, "common.js"));
assert.equal(common.normalizeTarget("192.168.1.20:8787"), "http://192.168.1.20:8787/");
assert.equal(common.normalizeTarget("100.100.10.10:8787"), "http://100.100.10.10:8787/");
assert.equal(common.normalizeTarget("tabmonger.local:8787"), "http://tabmonger.local:8787/");
assert.equal(common.normalizeTarget("tabmonger.example.com"), "https://tabmonger.example.com/");
assert.equal(common.normalizeTarget("https://example.com/tabmonger?view=compact#start"), "https://example.com/tabmonger");
assert.equal(common.permissionPattern("http://192.168.1.10:8787/"), "http://192.168.1.10/*");
assert.equal(common.healthUrl("http://192.168.1.10:8787/"), "http://192.168.1.10:8787/api/health");
assert.equal(common.healthUrl("https://example.com/tabmonger/"), "https://example.com/tabmonger/api/health");
for (const unsafe of ["javascript:alert(1)", "file:///tmp/tabmonger", "http://user:pass@localhost:8787/"]) {
  assert.throws(() => common.normalizeTarget(unsafe));
}

console.log(`Validated ${packageDirs.length} Manifest V3 packages, ${sourceFiles.length} shared files, URL safety, CSP, permissions, and icon sizes.`);
