// Browser-side debug-symbols implementation. Mirrors the export
// surface of debug-symbols.ts (which uses node:fs / node:crypto)
// so the worker can drive the same dispatch() label commands as
// the CLI. Persistence rides on top of OPFS — the same store the
// boot screen uses for ROMs, but under a separate `syms/` dir so
// label files are content-addressed by ROM id (or variant slug
// for the RAM / port files), not by md5.
//
// The esbuild plugin in esbuild.config.mjs redirects every
// `./debug-symbols.js` import to this file for the web bundles,
// so the same import sites in debug.ts pick up either flavour
// based on which entry point is being built.

import type { ResolveLabel, ResolvePort } from "../chips/z80/disasm.js";
import {
  emptySymbolFile,
  parseSymbolFile,
  removeSymbol,
  serialiseSymbolFile,
  setSymbol,
  type SymbolFile,
} from "../chips/z80/symbols.js";
import { md5 as md5sum } from "../web/md5.js";
import type { ROMDescriptor } from "./config.js";
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

async function readSymFile(name: string): Promise<string | null> {
  const dir = await getSymsDir();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return new TextDecoder().decode(await file.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeSymFile(name: string, text: string): Promise<void> {
  const dir = await getSymsDir();
  if (!dir) return;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// Pull the basename out of a syms/foo.sym path so the OPFS layer
// (which works on a single flat directory) sees plain filenames.
function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

interface DebugSymbolEntry {
  romId: string;
  romBytes: Uint8Array;
  file: SymbolFile;
}

export interface DebugSymbols {
  byRomId: Map<string, DebugSymbolEntry>;
  ramFile: SymbolFile;
  portFile: SymbolFile;
  resolver: ResolveLabel;
  exactResolver: ResolveLabel;
  portResolver: ResolvePort;
}

function variantSlug(machine: PC88Machine): string {
  return machine.config.model.toLowerCase().replace(/\W+/g, "");
}

export function romIdAt(machine: PC88Machine, addr: number): string | null {
  const mm = machine.memoryMap;
  if (!mm.basicROMEnabled) return null;
  const page = (addr >> 12) & 0xf;
  if (page <= 5) {
    return mm.basicMode === "n80"
      ? machine.config.roms.n80.id
      : machine.config.roms.n88.id;
  }
  if (page === 6 || page === 7) {
    if (mm.eromEnabled) {
      const erom = activeEromDescriptor(machine);
      if (erom) return erom.id;
    }
    return mm.basicMode === "n80"
      ? machine.config.roms.n80.id
      : machine.config.roms.n88.id;
  }
  return null;
}

function activeEromDescriptor(machine: PC88Machine): ROMDescriptor | undefined {
  const slot = machine.memoryMap.eromSlot;
  const r = machine.config.roms;
  switch (slot) {
    case 0:
      return r.e0;
    case 1:
      return r.e1;
    case 2:
      return r.e2;
    case 3:
      return r.e3;
  }
}

function bytesForRomAt(
  machine: PC88Machine,
  loaded: LoadedROMs,
  addr: number,
): Uint8Array | null {
  const id = romIdAt(machine, addr);
  if (!id) return null;
  if (id === machine.config.roms.n80.id) return loaded.n80;
  if (id === machine.config.roms.n88.id) return loaded.n88;
  if (machine.config.roms.e0?.id === id && loaded.e0) return loaded.e0;
  if (machine.config.roms.e1?.id === id && loaded.e1) return loaded.e1;
  if (machine.config.roms.e2?.id === id && loaded.e2) return loaded.e2;
  if (machine.config.roms.e3?.id === id && loaded.e3) return loaded.e3;
  return null;
}

function collectLoadedROMIDs(
  config: PC88Machine["config"],
  loaded: LoadedROMs,
): { id: string; bytes: Uint8Array }[] {
  const out: { id: string; bytes: Uint8Array }[] = [];
  out.push({ id: config.roms.n80.id, bytes: loaded.n80 });
  out.push({ id: config.roms.n88.id, bytes: loaded.n88 });
  if (config.roms.e0 && loaded.e0)
    out.push({ id: config.roms.e0.id, bytes: loaded.e0 });
  if (config.roms.e1 && loaded.e1)
    out.push({ id: config.roms.e1.id, bytes: loaded.e1 });
  if (config.roms.e2 && loaded.e2)
    out.push({ id: config.roms.e2.id, bytes: loaded.e2 });
  if (config.roms.e3 && loaded.e3)
    out.push({ id: config.roms.e3.id, bytes: loaded.e3 });
  return out;
}

async function loadOrEmpty(path: string): Promise<SymbolFile> {
  const text = await readSymFile(basename(path));
  return text ? parseSymbolFile(text, path) : emptySymbolFile(path);
}

async function save(file: SymbolFile): Promise<void> {
  await writeSymFile(basename(file.path), serialiseSymbolFile(file));
}

export async function loadDebugSymbols(
  machine: PC88Machine,
  loaded: LoadedROMs,
): Promise<DebugSymbols> {
  const byRomId = new Map<string, DebugSymbolEntry>();
  for (const { id, bytes } of collectLoadedROMIDs(machine.config, loaded)) {
    const file = await loadOrEmpty(`${SYMS_DIR}/${id}.sym`);
    byRomId.set(id, { romId: id, romBytes: bytes, file });
  }
  const slug = variantSlug(machine);
  const ramFile = await loadOrEmpty(`${SYMS_DIR}/${slug}.ram.sym`);
  const portFile = await loadOrEmpty(`${SYMS_DIR}/${slug}.port.sym`);

  const FUZZ = 16;
  const exact = (addr: number): string | undefined => {
    const id = romIdAt(machine, addr);
    if (id) return byRomId.get(id)?.file.byAddr.get(addr & 0xffff)?.name;
    return ramFile.byAddr.get(addr & 0xffff)?.name;
  };
  const resolver: ResolveLabel = (addr) => {
    const direct = exact(addr);
    if (direct !== undefined) return direct;
    for (let off = 1; off <= FUZZ; off++) {
      const name = exact((addr - off) & 0xffff);
      if (name !== undefined) return `${name}+${off}`;
    }
    return undefined;
  };
  const exactResolver: ResolveLabel = (addr) => exact(addr);
  const portResolver: ResolvePort = (port) =>
    portFile.byAddr.get(port & 0xff)?.name;

  return { byRomId, ramFile, portFile, resolver, exactResolver, portResolver };
}

function seedHeaderIfNew(file: SymbolFile, headerText: string): void {
  if (file.entries.length > 0) return;
  file.entries.push({ kind: "comment", text: headerText });
  file.entries.push({ kind: "blank" });
}

export async function addLabel(
  machine: PC88Machine,
  loaded: LoadedROMs,
  syms: DebugSymbols,
  addr: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> {
  const id = romIdAt(machine, addr);
  if (!id) {
    seedHeaderIfNew(syms.ramFile, `# RAM symbols for ${variantSlug(machine)}`);
    setSymbol(syms.ramFile, addr, name, comment);
    await save(syms.ramFile);
    return { scope: "ram", path: syms.ramFile.path };
  }
  const entry = syms.byRomId.get(id);
  if (!entry) {
    throw new Error(
      `no symbol-file entry for ROM ${id} (this shouldn't happen)`,
    );
  }
  if (entry.file.entries.length === 0 && !entry.file.md5) {
    const bytes = bytesForRomAt(machine, loaded, addr);
    if (bytes) {
      const md5 = md5sum(bytes);
      entry.file.md5 = md5;
      entry.file.entries.push({
        kind: "comment",
        text: `# Symbol file for ${id}.`,
      });
      entry.file.entries.push({ kind: "comment", text: `# md5: ${md5}` });
      entry.file.entries.push({ kind: "blank" });
    }
  }
  setSymbol(entry.file, addr, name, comment);
  await save(entry.file);
  return { scope: id, path: entry.file.path };
}

export async function addPortLabel(
  machine: PC88Machine,
  syms: DebugSymbols,
  port: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> {
  const masked = port & 0xff;
  seedHeaderIfNew(syms.portFile, `# Port symbols for ${variantSlug(machine)}`);
  setSymbol(syms.portFile, masked, name, comment);
  await save(syms.portFile);
  return { scope: "port", path: syms.portFile.path };
}

export async function deletePortLabel(
  syms: DebugSymbols,
  portOrName: number | string,
): Promise<{ scope: string; path: string } | null> {
  const target =
    typeof portOrName === "number" ? portOrName & 0xff : portOrName;
  if (!removeSymbol(syms.portFile, target)) return null;
  await save(syms.portFile);
  return { scope: "port", path: syms.portFile.path };
}

export async function deleteLabel(
  machine: PC88Machine,
  syms: DebugSymbols,
  addrOrName: number | string,
): Promise<{ scope: string; path: string } | null> {
  if (typeof addrOrName === "number") {
    const id = romIdAt(machine, addrOrName);
    if (id) {
      const entry = syms.byRomId.get(id);
      if (!entry) return null;
      if (!removeSymbol(entry.file, addrOrName)) return null;
      await save(entry.file);
      return { scope: id, path: entry.file.path };
    }
    if (removeSymbol(syms.ramFile, addrOrName)) {
      await save(syms.ramFile);
      return { scope: "ram", path: syms.ramFile.path };
    }
    return null;
  }
  for (const entry of syms.byRomId.values()) {
    if (removeSymbol(entry.file, addrOrName)) {
      await save(entry.file);
      return { scope: entry.romId, path: entry.file.path };
    }
  }
  if (removeSymbol(syms.ramFile, addrOrName)) {
    await save(syms.ramFile);
    return { scope: "ram", path: syms.ramFile.path };
  }
  if (removeSymbol(syms.portFile, addrOrName)) {
    await save(syms.portFile);
    return { scope: "port", path: syms.portFile.path };
  }
  return null;
}

export function renderLabelList(syms: DebugSymbols): string {
  const out: string[] = [];
  const renderFile = (label: string, file: SymbolFile, hexWidth: number) => {
    if (file.byAddr.size === 0) return;
    out.push(`-- ${label} (${file.byAddr.size} labels) --`);
    const sorted = [...file.byAddr.values()].sort((a, b) => a.addr - b.addr);
    for (const sym of sorted) {
      const a = "0x" + sym.addr.toString(16).padStart(hexWidth, "0");
      const c = sym.comment ? `  ; ${sym.comment}` : "";
      out.push(`  ${a}  ${sym.name}${c}`);
    }
  };
  for (const entry of syms.byRomId.values())
    renderFile(entry.romId, entry.file, 4);
  renderFile("ram", syms.ramFile, 4);
  renderFile("port", syms.portFile, 2);
  if (out.length === 0) return "(no labels loaded)";
  return out.join("\n");
}
