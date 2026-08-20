#!/usr/bin/env node

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(scriptDir, "..");
const sourceDir = join(extensionDir, "source");
const targets = [join(extensionDir, "chromium"), join(extensionDir, "firefox")];

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
  return output;
}

const sourceFiles = await filesBelow(sourceDir);
for (const targetDir of targets) {
  await stat(join(targetDir, "manifest.json"));
  for (const sourceFile of sourceFiles) {
    const destination = join(targetDir, relative(sourceDir, sourceFile));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourceFile, destination);
  }
}

console.log(`Synced ${sourceFiles.length} shared files into Chromium and Firefox packages.`);
