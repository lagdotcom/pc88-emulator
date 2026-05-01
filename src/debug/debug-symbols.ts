// Node-side binding for the shared debug-symbols core. Persists
// `syms/*.sym` to disk via node:fs and computes md5 headers via
// node:crypto. The browser counterpart lives in
// debug-symbols-browser.ts; both bind the same core API in
// debug-symbols-core.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { MD5Sum } from "../flavours.js";
import type { PC88Machine } from "../machines/pc88.js";
import type { LoadedROMs } from "../machines/pc88-memory.js";
import type { DebugSymbols, SymbolBackend } from "./debug-symbols-core.js";
import * as core from "./debug-symbols-core.js";

const SYMS_DIR = "syms";

const fsBackend: SymbolBackend = {
  async read(name) {
    const path = join(SYMS_DIR, name);
    if (!existsSync(path)) return null;
    return readFile(path, "utf-8");
  },
  async write(name, text) {
    const path = join(SYMS_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, text, "utf-8");
  },
  md5(bytes) {
    return createHash("md5").update(bytes).digest("hex") as MD5Sum;
  },
  warn(message) {
    process.stderr.write(`warning: ${message}\n`);
  },
};

export type { DebugSymbols, ImportResult } from "./debug-symbols-core.js";
export { renderLabelList, romIdAt } from "./debug-symbols-core.js";

export const importSymbols = (
  machine: PC88Machine,
  syms: DebugSymbols,
  files: { name: string; text: string; scope?: string }[],
): Promise<core.ImportResult[]> =>
  core.importSymbols(fsBackend, machine, syms, files);

export const loadDebugSymbols = (
  machine: PC88Machine,
  loaded: LoadedROMs,
): Promise<DebugSymbols> => core.loadDebugSymbols(fsBackend, machine, loaded);

export const addLabel = (
  machine: PC88Machine,
  loaded: LoadedROMs,
  syms: DebugSymbols,
  addr: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> =>
  core.addLabel(fsBackend, machine, loaded, syms, addr, name, comment);

export const addPortLabel = (
  machine: PC88Machine,
  syms: DebugSymbols,
  port: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> =>
  core.addPortLabel(fsBackend, machine, syms, port, name, comment);

export const deletePortLabel = (
  syms: DebugSymbols,
  portOrName: number | string,
): Promise<{ scope: string; path: string } | null> =>
  core.deletePortLabel(fsBackend, syms, portOrName);

export const deleteLabel = (
  machine: PC88Machine,
  syms: DebugSymbols,
  addrOrName: number | string,
): Promise<{ scope: string; path: string } | null> =>
  core.deleteLabel(fsBackend, machine, syms, addrOrName);
