// Symbol files describe well-known addresses (code labels, data
// strings, RAM hooks) for a specific ROM image. The disassembler
// and debugger consume them to render `CALL print_string` instead
// of `CALL 0x5550`, and the debugger lets the user mutate them at
// runtime — every change is persisted back to disk so symbols
// accumulate across sessions.
//
// File format (one symbol per line, plain text, easy to grep / diff):
//
//   # Symbol file for mkI-n88. Lines starting with # are comments,
//   # preserved verbatim on rewrite. Blank lines preserved too.
//   # md5: 22be239bc0c4298bc0561252eed98633
//
//   # Banner & print path
//   0x5550 print_string         ; print NUL-terminated string at HL
//   0x5925 print_handler        ; main char-print path
//
// Symbol lines: `0xHHHH  name  ; optional inline comment`.
// Names follow C identifier rules (letter/_ start, [A-Za-z0-9_]
// thereafter). The optional `# md5: <hash>` comment, if present,
// is checked against the actual ROM image at load time and a
// warning is emitted on mismatch — the symbols still load.
//
// Comment preservation: file-level comments and blank lines round-
// trip through load + save unchanged. Inline comments stay attached
// to their symbol; if you rename a symbol the comment is kept.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const MD5_HEADER_RE = /^\s*#\s*md5:\s*([0-9a-fA-F]{32})\s*$/;
const SYMBOL_LINE_RE =
  /^\s*0x([0-9A-Fa-f]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:;(.*))?\s*$/;
const COMMENT_LINE_RE = /^\s*(#.*)?$/;

export interface SymbolEntry {
  addr: number;
  name: string;
  // Inline `; ...` comment; preserved across rewrites.
  comment?: string;
}

// Internal entry type — preserves the original line shape so that
// rewriting keeps blank lines / comments / whitespace intact.
// Symbol entries carry the line they were parsed from so users'
// hand-tuned alignment survives round-trips. setSymbol() and
// auto-write paths drop the verbatim line so the rewrite uses
// canonical formatting after a mutation.
type FileEntry =
  | { kind: "symbol"; symbol: SymbolEntry; originalLine?: string }
  | { kind: "comment"; text: string }
  | { kind: "blank" };

export interface SymbolFile {
  // Quick lookup; same SymbolEntry instances as in `entries`.
  byAddr: Map<number, SymbolEntry>;
  byName: Map<string, SymbolEntry>;
  // Optional md5 from the `# md5: <hash>` header line.
  md5?: string;
  // Ordered list of every line in the file. Used to rewrite the
  // file with comments + blank lines preserved.
  entries: FileEntry[];
  // Path the file was loaded from; saved-to on rewrites.
  path: string;
}

// Read-only view used by callers that just want to look symbols up
// (disassembler, debugger prompt). Trivially backed by SymbolFile
// but composeable: in phase 2 we'll merge per-ROM + RAM + port
// tables behind this same interface.
export interface SymbolTable {
  lookup(addr: number): string | undefined;
}

export function symbolTable(file: SymbolFile): SymbolTable {
  return {
    lookup: (addr) => file.byAddr.get(addr & 0xffff)?.name,
  };
}

// Compose multiple SymbolTables — first hit wins. Useful when the
// debugger has both a per-ROM table and a variant-wide RAM table.
export function mergeSymbolTables(...tables: SymbolTable[]): SymbolTable {
  return {
    lookup: (addr) => {
      for (const t of tables) {
        const n = t.lookup(addr);
        if (n !== undefined) return n;
      }
      return undefined;
    },
  };
}

export function parseSymbolFile(text: string, path: string): SymbolFile {
  const entries: FileEntry[] = [];
  const byAddr = new Map<number, SymbolEntry>();
  const byName = new Map<string, SymbolEntry>();
  let md5: string | undefined;

  // Drop the empty trailing element split produces when the file
  // ends with a newline (which it almost always should). Otherwise
  // we'd round-trip a trailing blank line into an extra \n on save.
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/, ""); // trim trailing whitespace only
    if (line.length === 0) {
      entries.push({ kind: "blank" });
      continue;
    }
    const md5Match = line.match(MD5_HEADER_RE);
    if (md5Match) {
      md5 = md5Match[1]!.toLowerCase();
      // Treat the md5 header as a regular comment line so it survives
      // rewrites verbatim — we just remember its value.
      entries.push({ kind: "comment", text: line });
      continue;
    }
    const symMatch = line.match(SYMBOL_LINE_RE);
    if (symMatch) {
      const addr = parseInt(symMatch[1]!, 16) & 0xffff;
      const name = symMatch[2]!;
      const inline = symMatch[3]?.trim();
      const symbol: SymbolEntry = inline
        ? { addr, name, comment: inline }
        : { addr, name };
      entries.push({ kind: "symbol", symbol, originalLine: line });
      byAddr.set(addr, symbol);
      byName.set(name, symbol);
      continue;
    }
    if (COMMENT_LINE_RE.test(line)) {
      entries.push({ kind: "comment", text: line });
      continue;
    }
    // Unrecognised line — preserve as a comment so the file round-
    // trips, but warn callers via a special prefix.
    entries.push({ kind: "comment", text: `# [unparsed] ${line}` });
  }

  const file: SymbolFile = { byAddr, byName, entries, path };
  if (md5 !== undefined) file.md5 = md5;
  return file;
}

export function serialiseSymbolFile(file: SymbolFile): string {
  const lines: string[] = [];
  for (const entry of file.entries) {
    switch (entry.kind) {
      case "blank":
        lines.push("");
        break;
      case "comment":
        lines.push(entry.text);
        break;
      case "symbol": {
        // If the symbol hasn't been mutated since parse, emit its
        // original line verbatim so the user's alignment survives.
        if (entry.originalLine !== undefined) {
          lines.push(entry.originalLine);
          break;
        }
        const s = entry.symbol;
        const addrStr = "0x" + s.addr.toString(16).padStart(4, "0");
        const base = `${addrStr} ${s.name}`;
        lines.push(s.comment ? `${base}  ; ${s.comment}` : base);
        break;
      }
    }
  }
  // Trailing newline so editors don't moan.
  return lines.join("\n") + "\n";
}

// Add or update a symbol. If a symbol already exists at `addr`, the
// name and inline comment are replaced (and the old name's byName
// entry is dropped). Existing comments are preserved when the
// caller doesn't supply a new one.
export function setSymbol(
  file: SymbolFile,
  addr: number,
  name: string,
  comment?: string,
): void {
  const norm = addr & 0xffff;
  const existing = file.byAddr.get(norm);
  if (existing) {
    file.byName.delete(existing.name);
    existing.name = name;
    if (comment !== undefined) existing.comment = comment;
    file.byName.set(name, existing);
    // Mutation drops the verbatim line so the rewrite emits the
    // canonical form with the new name / comment.
    const idx = file.entries.findIndex(
      (e) => e.kind === "symbol" && e.symbol === existing,
    );
    if (idx >= 0) {
      const e = file.entries[idx]!;
      if (e.kind === "symbol") delete e.originalLine;
    }
    return;
  }
  const symbol: SymbolEntry = comment
    ? { addr: norm, name, comment }
    : { addr: norm, name };
  file.entries.push({ kind: "symbol", symbol });
  file.byAddr.set(norm, symbol);
  file.byName.set(name, symbol);
}

// Remove by address or by name. Returns true if a symbol was
// removed. Comments and blank lines around the symbol are kept;
// only the symbol's line vanishes.
export function removeSymbol(
  file: SymbolFile,
  addrOrName: number | string,
): boolean {
  let target: SymbolEntry | undefined;
  if (typeof addrOrName === "number") {
    target = file.byAddr.get(addrOrName & 0xffff);
  } else {
    target = file.byName.get(addrOrName);
  }
  if (!target) return false;
  file.byAddr.delete(target.addr);
  file.byName.delete(target.name);
  const idx = file.entries.findIndex(
    (e) => e.kind === "symbol" && e.symbol === target,
  );
  if (idx >= 0) file.entries.splice(idx, 1);
  return true;
}

// Empty file used when no symbol file exists yet but the caller
// wants a writable handle (debugger creating labels for the first
// time).
export function emptySymbolFile(path: string): SymbolFile {
  return {
    byAddr: new Map(),
    byName: new Map(),
    entries: [],
    path,
  };
}

export async function loadSymbolFile(path: string): Promise<SymbolFile | null> {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf-8");
  return parseSymbolFile(text, path);
}

export async function saveSymbolFile(file: SymbolFile): Promise<void> {
  await writeFile(file.path, serialiseSymbolFile(file), "utf-8");
}
