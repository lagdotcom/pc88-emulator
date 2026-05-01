// Browser-side binding for the shared debug-symbols core. Persists
// `syms/*.sym` to OPFS via navigator.storage.getDirectory() and
// computes md5 headers via the same js-md5 wrapper the boot screen
// uses. The Node counterpart lives in debug-symbols.ts; both bind
// the same core API in debug-symbols-core.ts.
//
// The esbuild plugin in esbuild.config.mjs redirects every
// `./debug-symbols.js` import to this file for the web bundles, so
// debug.ts's import sites pick up either flavour based on which
// entry point is being built.

import { md5 as md5sum } from "../md5.js";
import type { DebugSymbols, SymbolBackend } from "./debug-symbols-core.js";
import * as core from "./debug-symbols-core.js";
import type { PC88Machine } from "./pc88.js";
import type { LoadedROMs } from "./pc88-memory.js";

const SYMS_DIR = "syms";

// Minimal OPFS surface — duplicated from src/web/opfs.ts so this
// module doesn't have to round-trip through the boot-screen store
// (which lives on the main thread). The worker opens its own handle
// against the same OPFS root.
interface OpfsDir {
  getDirectoryHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<OpfsDir>;
  getFileHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<OpfsFile>;
}
interface OpfsFile {
  getFile: () => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
  createWritable: () => Promise<{
    write: (data: BufferSource | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

let symsDirPromise: Promise<OpfsDir | null> | null = null;

async function getSymsDir(): Promise<OpfsDir | null> {
  if (symsDirPromise) return symsDirPromise;
  symsDirPromise = (async () => {
    const storage = (
      globalThis as {
        navigator?: { storage?: { getDirectory?: () => Promise<OpfsDir> } };
      }
    ).navigator?.storage;
    if (!storage?.getDirectory) return null;
    try {
      const root = await storage.getDirectory();
      return await root.getDirectoryHandle(SYMS_DIR, { create: true });
    } catch {
      return null;
    }
  })();
  return symsDirPromise;
}

const opfsBackend: SymbolBackend = {
  async read(name) {
    const dir = await getSymsDir();
    if (!dir) return null;
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return new TextDecoder().decode(await file.arrayBuffer());
    } catch {
      return null;
    }
  },
  async write(name, text) {
    const dir = await getSymsDir();
    if (!dir) return;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  },
  md5(bytes) {
    return md5sum(bytes);
  },
};

export type { DebugSymbols } from "./debug-symbols-core.js";
export { renderLabelList, romIdAt } from "./debug-symbols-core.js";

export const loadDebugSymbols = (
  machine: PC88Machine,
  loaded: LoadedROMs,
): Promise<DebugSymbols> => core.loadDebugSymbols(opfsBackend, machine, loaded);

export const addLabel = (
  machine: PC88Machine,
  loaded: LoadedROMs,
  syms: DebugSymbols,
  addr: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> =>
  core.addLabel(opfsBackend, machine, loaded, syms, addr, name, comment);

export const addPortLabel = (
  machine: PC88Machine,
  syms: DebugSymbols,
  port: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> =>
  core.addPortLabel(opfsBackend, machine, syms, port, name, comment);

export const deletePortLabel = (
  syms: DebugSymbols,
  portOrName: number | string,
): Promise<{ scope: string; path: string } | null> =>
  core.deletePortLabel(opfsBackend, syms, portOrName);

export const deleteLabel = (
  machine: PC88Machine,
  syms: DebugSymbols,
  addrOrName: number | string,
): Promise<{ scope: string; path: string } | null> =>
  core.deleteLabel(opfsBackend, machine, syms, addrOrName);
