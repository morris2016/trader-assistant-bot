#!/usr/bin/env node
// Tiny launcher that deletes ELECTRON_RUN_AS_NODE before spawning electron-vite.
// Shell-level env overrides haven't worked reliably on this Windows setup.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const subcommand = process.argv[2];
if (!subcommand) {
  console.error("usage: node scripts/run.mjs <dev|build|preview>");
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const js = join(here, "..", "node_modules", "electron-vite", "bin", "electron-vite.js");

const child = spawn(process.execPath, [js, subcommand], {
  stdio: "inherit",
  env,
  shell: false,
});
child.on("exit", (code) => process.exit(code ?? 0));
