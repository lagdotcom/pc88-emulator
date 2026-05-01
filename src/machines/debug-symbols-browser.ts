// Browser-side stub of debug-symbols.ts for the web bundle. The real
// module reads/writes `syms/*.sym` via Node fs and computes md5
// headers via Node crypto — neither is available in the worker, and
// the OPFS-backed write path for symbol files is still TODO (phase
// 4b decision: defer label persistence until OPFS write is wired,
// or downgrade to in-memory and surface an "Export symbols" button).
//
// For now: every symbol command is a no-op. The REPL passes
// `syms = null` so dispatch never reaches these — we only need the
// imports to resolve so debug.ts type-checks under the browser
// alias.

/* eslint-disable @typescript-eslint/no-unused-vars */

import type { ResolveLabel, ResolvePort } from "../chips/z80/disasm.js";
import type { ROMID, u16 } from "../flavours.js";
import type { PC88Machine } from "./pc88.js";

interface SymbolFile {
  path: string;
  byAddr: Map<u16, string>;
}

interface DebugSymbolEntry {
  romId: ROMID;
  romBytes: Uint8Array;
  file: SymbolFile;
}

export interface DebugSymbols {
  byRomId: Map<ROMID, DebugSymbolEntry>;
  ramFile: SymbolFile;
  portFile: SymbolFile;
  resolver: ResolveLabel;
  exactResolver: ResolveLabel;
  portResolver: ResolvePort;
}

// The functions below match the real module's signatures. None of
// them are reached during normal browser-side use (the worker passes
// `syms = null` into the dispatcher), but the imports must resolve
// because debug.ts pulls them in at module top.

export async function addLabel(
  _syms: DebugSymbols,
  _machine: PC88Machine,
  _addr: u16,
  _name: string,
  _comment?: string,
): Promise<void> {
  return;
}

export async function deleteLabel(
  _syms: DebugSymbols,
  _machine: PC88Machine,
  _key: u16 | string,
): Promise<{ removed: number }> {
  return { removed: 0 };
}

export async function addPortLabel(
  _syms: DebugSymbols,
  _machine: PC88Machine,
  _port: number,
  _name: string,
): Promise<void> {
  return;
}

export async function deletePortLabel(
  _syms: DebugSymbols,
  _machine: PC88Machine,
  _key: number | string,
): Promise<{ removed: number }> {
  return { removed: 0 };
}

export function renderLabelList(_syms: DebugSymbols): string {
  return "  (symbol persistence not yet available in the browser)\n";
}

// Used by debug-cli.ts only; the worker doesn't import this. Keeps
// the export surface symmetric so esbuild's alias resolves cleanly.
export async function loadDebugSymbols(
  _machine: PC88Machine,
  _roms: unknown,
): Promise<DebugSymbols | null> {
  return null;
}

export function romIdAt(_machine: PC88Machine, _addr: u16): string | null {
  return null;
}
