// Debugger ↔ symbol-file glue. Owns the per-ROM SymbolFile cache,
// resolves CPU addresses to ROM ids based on the live memory map,
// and persists every mutation eagerly so labels accumulate across
// sessions.
//
// Memory-map awareness is the key piece: address 0x5550 means
// different things depending on whether n80 or n88 is currently
// mapped at 0x0000-0x5FFF, and 0x6500 depends on whether an E-ROM
// is enabled. romIdAt() consults the same map state the CPU sees
// to dispatch lookups + mutations to the right per-ROM file.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ResolveLabel } from "../chips/z80/disasm.js";
import {
  emptySymbolFile,
  loadSymbolFile,
  removeSymbol,
  saveSymbolFile,
  setSymbol,
  type SymbolFile,
} from "../chips/z80/symbols.js";
import type { FilesystemPath, ROMID } from "../flavours.js";
import type { ROMDescriptor } from "./config.js";
import type { PC88Machine } from "./pc88.js";
import type { LoadedROMs } from "./pc88-memory.js";

const SYMS_DIR: FilesystemPath = "syms";

interface DebugSymbolEntry {
  romId: ROMID;
  romBytes: Uint8Array; // for md5 computation when seeding a new file
  file: SymbolFile;
}

export interface DebugSymbols {
  byRomId: Map<ROMID, DebugSymbolEntry>;
  // The resolver to pass to disassemble() — captures `this` so
  // memory-map state at lookup time picks the right ROM.
  resolver: ResolveLabel;
}

// Determine which ROM id is mapped at `addr` right now, given the
// machine's live memory-map state. Returns null for RAM regions
// (those will be in a separate variant-wide RAM symbol file in
// phase 3).
export function romIdAt(machine: PC88Machine, addr: u16): string | null {
  const mm = machine.memoryMap;
  if (!mm.basicRomEnabled) return null;
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

// Type alias for u16 to avoid pulling flavours into a debug-only
// module — phase 3 might split this file out further.
type u16 = number;

// Bytes for whichever ROM image is mapped at `addr`. Used by the
// md5-on-create path so a newly-touched symbol file can self-seed
// its header.
function bytesForRomAt(
  machine: PC88Machine,
  loaded: LoadedROMs,
  addr: u16,
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

// Load symbol files for every ROM the machine has byte data for.
// Files that don't exist yet are represented by empty SymbolFile
// records pointing at the path we'd save to — that way `label`
// can write a fresh file on first use.
export async function loadDebugSymbols(
  machine: PC88Machine,
  loaded: LoadedROMs,
): Promise<DebugSymbols> {
  const byRomId = new Map<string, DebugSymbolEntry>();
  for (const { id, bytes } of collectLoadedROMIDs(machine.config, loaded)) {
    const path = join(SYMS_DIR, `${id}.sym`);
    const file = (await loadSymbolFile(path)) ?? emptySymbolFile(path);
    if (file.md5) {
      const got = createHash("md5").update(bytes).digest("hex");
      if (got !== file.md5) {
        process.stderr.write(
          `warning: ${path} declares md5=${file.md5} but ROM is ${got}\n`,
        );
      }
    }
    byRomId.set(id, { romId: id, romBytes: bytes, file });
  }

  const resolver: ResolveLabel = (addr) => {
    const id = romIdAt(machine, addr);
    if (!id) return undefined;
    return byRomId.get(id)?.file.byAddr.get(addr & 0xffff)?.name;
  };

  return { byRomId, resolver };
}

// Add or rename a label. Determines which ROM the address belongs
// to, mutates that ROM's symbol file, and writes the file back to
// disk eagerly. The very first mutation against a previously-empty
// file seeds it with a `# md5: <hash>` header line so future loads
// can detect ROM-revision drift.
export async function addLabel(
  machine: PC88Machine,
  loaded: LoadedROMs,
  syms: DebugSymbols,
  addr: u16,
  name: string,
  comment?: string,
): Promise<{ romId: ROMID; path: FilesystemPath }> {
  const id = romIdAt(machine, addr);
  if (!id) {
    throw new Error(
      `address 0x${addr.toString(16)} isn't in a ROM region; phase 3 will add RAM/port label support`,
    );
  }
  const entry = syms.byRomId.get(id);
  if (!entry) {
    throw new Error(
      `no symbol-file entry for ROM ${id} (this shouldn't happen)`,
    );
  }

  // First-mutation seeding: stamp the md5 header so a future load
  // can sanity-check it. Skip if the file already has anything
  // (including a header the user wrote by hand).
  if (entry.file.entries.length === 0 && !entry.file.md5) {
    const bytes = bytesForRomAt(machine, loaded, addr);
    if (bytes) {
      const md5 = createHash("md5").update(bytes).digest("hex");
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
  // Make sure the syms/ directory exists on first write.
  mkdirSync(dirname(entry.file.path), { recursive: true });
  await saveSymbolFile(entry.file);
  return { romId: id, path: entry.file.path };
}

// Remove a label by address or name. If by address, the lookup
// uses the live memory-map state to pick the right ROM (so
// `unlabel 0x5550` while N88 is mapped removes from mkI-n88.sym,
// not mkI-n80.sym). If by name, every ROM file is searched.
export async function deleteLabel(
  machine: PC88Machine,
  syms: DebugSymbols,
  addrOrName: u16 | string,
): Promise<{ romId: ROMID; path: FilesystemPath } | null> {
  if (typeof addrOrName === "number") {
    const id = romIdAt(machine, addrOrName);
    if (!id) return null;
    const entry = syms.byRomId.get(id);
    if (!entry) return null;
    if (!removeSymbol(entry.file, addrOrName)) return null;
    await saveSymbolFile(entry.file);
    return { romId: id, path: entry.file.path };
  }
  // Name-based: search every loaded file.
  for (const entry of syms.byRomId.values()) {
    if (removeSymbol(entry.file, addrOrName)) {
      await saveSymbolFile(entry.file);
      return { romId: entry.romId, path: entry.file.path };
    }
  }
  return null;
}

// Render the full label table grouped by ROM id, sorted by
// address within each group. Empty ROM files are skipped so the
// list isn't padded with header-only blocks.
export function renderLabelList(syms: DebugSymbols): string {
  const out: string[] = [];
  for (const entry of syms.byRomId.values()) {
    if (entry.file.byAddr.size === 0) continue;
    out.push(`-- ${entry.romId} (${entry.file.byAddr.size} labels) --`);
    const sorted = [...entry.file.byAddr.values()].sort(
      (a, b) => a.addr - b.addr,
    );
    for (const sym of sorted) {
      const a = "0x" + sym.addr.toString(16).padStart(4, "0");
      const c = sym.comment ? `  ; ${sym.comment}` : "";
      out.push(`  ${a}  ${sym.name}${c}`);
    }
  }
  if (out.length === 0) {
    return "(no labels loaded)";
  }
  return out.join("\n");
}
