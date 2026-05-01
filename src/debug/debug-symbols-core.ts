// Backend-agnostic debugger symbol-file logic. The Node CLI and the
// browser worker both share this code; only the I/O strip
// (file read/write + md5) differs between them. Each environment
// supplies a `SymbolBackend`; the thin wrappers in
// debug-symbols.ts (fs + node:crypto) and
// debug-symbols-browser.ts (OPFS + js-md5) bind a backend and
// re-export the same surface.
//
// Memory-map awareness is the key piece: address 0x5550 means
// different things depending on whether n80 or n88 is currently
// mapped at 0x0000-0x5FFF, and 0x6500 depends on whether an E-ROM
// is enabled. romIdAt() consults the same map state the CPU sees
// to dispatch lookups + mutations to the right per-ROM file.

import type { ResolveLabel, ResolvePort } from "../chips/z80/disasm.js";
import {
  emptySymbolFile,
  parseSymbolFile,
  removeSymbol,
  serialiseSymbolFile,
  setSymbol,
  type SymbolFile,
} from "../chips/z80/symbols.js";
import type { MD5Sum, ROMID } from "../flavours.js";
import type { ROMDescriptor } from "../machines/config.js";
import type { PC88Machine } from "../machines/pc88.js";
import type { LoadedROMs } from "../machines/pc88-memory.js";

const SYMS_DIR = "syms";

// Single bytewise representation of a syms file is a string —
// `parseSymbolFile` / `serialiseSymbolFile` round-trip through one.
// The backend doesn't have to know about `SymbolFile` directly; it
// just stores text under a key and computes md5s for header seeding.
export interface SymbolBackend {
  // Returns the file's contents, or null if it doesn't exist.
  // `name` is a bare basename (e.g. "mkI-n88.sym"); the backend is
  // responsible for any directory scoping.
  read(name: string): Promise<string | null>;
  // Overwrite the file with the given text.
  write(name: string, text: string): Promise<void>;
  // Compute an md5 over the given bytes. Distinct from the file
  // I/O so the same backend abstraction works for both node:crypto
  // and js-md5.
  md5(bytes: Uint8Array): MD5Sum;
}

interface DebugSymbolEntry {
  romId: ROMID;
  romBytes: Uint8Array; // for md5 computation when seeding a new file
  file: SymbolFile;
}

export interface DebugSymbols {
  byRomId: Map<ROMID, DebugSymbolEntry>;
  // Variant-wide RAM (addresses outside ROM regions) and port
  // labels. One file per variant, shared across N-BASIC and
  // N88-BASIC. Always present — empty files are created on first
  // mutation, same pattern as the per-ROM files.
  ramFile: SymbolFile;
  portFile: SymbolFile;
  // The resolver to pass to disassemble() — captures `this` so
  // memory-map state at lookup time picks the right ROM. Includes
  // fuzzy "name+N" fall-through within a 16-byte window.
  resolver: ResolveLabel;
  // Exact-only variant of `resolver`: returns a label only when the
  // address is exactly a labelled symbol, never a `+N` fall-through.
  // Used for the per-line label headers in disassembly listings so
  // every mid-function instruction doesn't get a `name+N:` header.
  exactResolver: ResolveLabel;
  // Port-number resolver for IN A,(n) / OUT (n),A.
  portResolver: ResolvePort;
}

// Per-variant slug used to name the RAM and port symbol files.
// Keeps it readable: "PC-8801 mkII SR" → "pc8801mkiisr".
function variantSlug(machine: PC88Machine): string {
  return machine.config.model.toLowerCase().replace(/\W+/g, "");
}

// Determine which ROM id is mapped at `addr` right now, given the
// machine's live memory-map state. Returns null for RAM regions —
// those route to the variant-wide RAM symbol file (`ramFile`).
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
    // Falls through to BASIC ROM continuation when E-ROM is
    // disabled or the active slot has no image.
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

// Bytes for whichever ROM image is mapped at `addr`. Used by the
// md5-on-create path so a newly-touched symbol file can self-seed
// its header.
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

// Walk the ROM manifest for IDs we have loaded byte arrays for. The
// debugger only cares about ROMs whose contents are actually in
// memory; absent optional slots are skipped.
function collectLoadedROMIDs(
  config: PC88Machine["config"],
  loaded: LoadedROMs,
): { id: ROMID; bytes: Uint8Array }[] {
  const out: { id: ROMID; bytes: Uint8Array }[] = [];
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

async function loadOrEmpty(
  backend: SymbolBackend,
  name: string,
): Promise<SymbolFile> {
  const path = `${SYMS_DIR}/${name}`;
  const text = await backend.read(name);
  return text ? parseSymbolFile(text, path) : emptySymbolFile(path);
}

async function save(backend: SymbolBackend, file: SymbolFile): Promise<void> {
  // file.path is "syms/<name>" — pull the basename for the backend.
  const name = file.path.startsWith(`${SYMS_DIR}/`)
    ? file.path.slice(SYMS_DIR.length + 1)
    : file.path;
  await backend.write(name, serialiseSymbolFile(file));
}

export async function loadDebugSymbols(
  backend: SymbolBackend,
  machine: PC88Machine,
  loaded: LoadedROMs,
): Promise<DebugSymbols> {
  const byRomId = new Map<string, DebugSymbolEntry>();
  for (const { id, bytes } of collectLoadedROMIDs(machine.config, loaded)) {
    const file = await loadOrEmpty(backend, `${id}.sym`);
    if (file.md5) {
      const got = backend.md5(bytes);
      if (got !== file.md5) {
        // The CLI driver historically wrote this to stderr; the
        // browser stays silent. The mismatch is a warning, not a
        // hard error — symbols still load.

        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            `${file.path} declares md5=${file.md5} but ROM is ${got}`,
          );
        }
      }
    }
    byRomId.set(id, { romId: id, romBytes: bytes, file });
  }
  const slug = variantSlug(machine);
  const ramFile = await loadOrEmpty(backend, `${slug}.ram.sym`);
  const portFile = await loadOrEmpty(backend, `${slug}.port.sym`);

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
  backend: SymbolBackend,
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
    await save(backend, syms.ramFile);
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
      const md5 = backend.md5(bytes);
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
  await save(backend, entry.file);
  return { scope: id, path: entry.file.path };
}

export async function addPortLabel(
  backend: SymbolBackend,
  machine: PC88Machine,
  syms: DebugSymbols,
  port: number,
  name: string,
  comment?: string,
): Promise<{ scope: string; path: string }> {
  const masked = port & 0xff;
  seedHeaderIfNew(syms.portFile, `# Port symbols for ${variantSlug(machine)}`);
  setSymbol(syms.portFile, masked, name, comment);
  await save(backend, syms.portFile);
  return { scope: "port", path: syms.portFile.path };
}

export async function deletePortLabel(
  backend: SymbolBackend,
  syms: DebugSymbols,
  portOrName: number | string,
): Promise<{ scope: string; path: string } | null> {
  const target =
    typeof portOrName === "number" ? portOrName & 0xff : portOrName;
  if (!removeSymbol(syms.portFile, target)) return null;
  await save(backend, syms.portFile);
  return { scope: "port", path: syms.portFile.path };
}

export async function deleteLabel(
  backend: SymbolBackend,
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
      await save(backend, entry.file);
      return { scope: id, path: entry.file.path };
    }
    if (removeSymbol(syms.ramFile, addrOrName)) {
      await save(backend, syms.ramFile);
      return { scope: "ram", path: syms.ramFile.path };
    }
    return null;
  }
  for (const entry of syms.byRomId.values()) {
    if (removeSymbol(entry.file, addrOrName)) {
      await save(backend, entry.file);
      return { scope: entry.romId, path: entry.file.path };
    }
  }
  if (removeSymbol(syms.ramFile, addrOrName)) {
    await save(backend, syms.ramFile);
    return { scope: "ram", path: syms.ramFile.path };
  }
  if (removeSymbol(syms.portFile, addrOrName)) {
    await save(backend, syms.portFile);
    return { scope: "port", path: syms.portFile.path };
  }
  return null;
}

// renderLabelList is pure — no backend needed.
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
