// CLI disassembler. Reads a raw binary ROM file and disassembles
// bytes from it as Z80 code. No variant / machine emulation needed
// — useful for inspecting any ROM dump (PC-88 BIOS, BASIC, fonts,
// or even unrelated Z80 binaries).
//
//   yarn dis <file>                  # 16 instr from start of file
//   yarn dis <file> 0x100            # 16 instr from file offset 0x100
//   yarn dis <file> 0x100 32         # 32 instr
//   yarn dis --base=0x6000 e0.rom 0x6010
//                                    # treat file as loaded at 0x6000;
//                                    # disassemble at CPU addr 0x6010
//                                    # (which is file offset 0x10).
//                                    # JR / CALL targets render with
//                                    # the base address applied.
//
// Symbols: by default `yarn dis path/to/<rom>.rom` looks for
// `syms/<rom>.sym` next to the working directory and substitutes
// label names for resolved addresses. If the symbol file has a
// `# md5: <hash>` header, it's checked against the ROM and a
// warning printed to stderr on mismatch (symbols still load).
//
//   --syms=PATH        explicit symbol-file path
//   --syms=off         disable label substitution
//
// The optional <addr> is a CPU-side address — the file is accessed
// at offset (addr - base). Hex (0x... / trailing letters) and
// decimal both work.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";

import { disassemble } from "./chips/z80/disasm.js";
import {
  fuzzySymbolTable,
  loadSymbolFile,
  mergeSymbolTables,
  type SymbolTable,
  symbolTable,
} from "./chips/z80/symbols.js";
import type { FilesystemPath, u8, u16 } from "./flavours.js";
import { byte, hex, word } from "./tools.js";

const HELP = `\
yarn dis — disassemble bytes from a raw ROM file as Z80 code

  yarn dis [options] <file> [<addr> [<count>]]

Options:
  --base=ADDR    address the file is "loaded at" (default 0). The
                 file is read at offset (addr - base); JR / JP / CALL
                 targets render in the same address space.
  --syms=PATH    per-ROM symbol-file path. Default: syms/<basename>.sym
                 next to the working directory. Pass "off" to disable.
  --ram-syms=PATH    auxiliary RAM symbol file (no auto-detect; merged
                     with --syms via name+offset fuzzy resolution)
  --port-syms=PATH   auxiliary port symbol file; substitutes labels in
                     IN A,(n) / OUT (n),A operands
  -h, --help     this help

Positional args:
  <file>      path to the ROM / binary
  [addr]      starting CPU-side address (default = base)
  [count]     number of instructions (default 16, max 1024)

Examples:
  yarn dis roms/mkI-n80.rom 0x0000 32
  yarn dis --base=0x6000 roms/mkI-e0.rom 0x6010 16
  yarn dis --syms=off roms/mkI-n88.rom 0x5550 8
`;

function parseAddrFlag(raw: string): u16 | null {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("0x")) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n & 0xffff : null;
  }
  if (/^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) {
    return parseInt(s, 16) & 0xffff;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n & 0xffff : null;
}

// Map a ROM-file path to its default symbol-file path:
//   roms/mkI-n88.rom  →  syms/mkI-n88.sym
// Used when --syms isn't given.
function defaultSymsPath(romPath: FilesystemPath): FilesystemPath {
  const ext = extname(romPath);
  const stem = basename(romPath, ext);
  return join("syms", `${stem}.sym`);
}

// Plain loader for auxiliary (RAM / port) symbol files — no md5
// check (those files don't correspond to a single binary).
async function loadAuxSymbols(
  path: FilesystemPath,
): Promise<SymbolTable | undefined> {
  const file = await loadSymbolFile(path);
  if (!file) {
    throw new Error(`symbol file not found: ${path}`);
  }
  process.stderr.write(`; loaded ${file.byAddr.size} symbols from ${path}\n`);
  return symbolTable(file);
}

async function loadSymbols(
  symsArg: FilesystemPath | undefined,
  romPath: FilesystemPath,
  romBytes: Uint8Array,
): Promise<SymbolTable | undefined> {
  if (symsArg === "off") return undefined;
  const path = symsArg ?? defaultSymsPath(romPath);
  const file = await loadSymbolFile(path);
  if (!file) {
    if (symsArg !== undefined) {
      // Explicit path that doesn't exist — surface as an error so
      // typos don't silently fall back to "no symbols".
      throw new Error(`symbol file not found: ${path}`);
    }
    return undefined;
  }
  // md5 mismatch is a warning, not a fatal error — user might
  // intentionally be applying older symbols to a new revision.
  if (file.md5) {
    const got = createHash("md5").update(romBytes).digest("hex");
    if (got !== file.md5) {
      process.stderr.write(
        `warning: symbol file ${path} declares md5=${file.md5} but the ROM is ${got}\n`,
      );
    }
  }
  process.stderr.write(`; loaded ${file.byAddr.size} symbols from ${path}\n`);
  return symbolTable(file);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      syms: { type: "string" },
      "ram-syms": { type: "string" },
      "port-syms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  const filePath = positionals[0]!;
  const base = values.base ? (parseAddrFlag(values.base) ?? 0) : 0;
  const startAddr =
    positionals[1] !== undefined ? parseAddrFlag(positionals[1]) : base;
  if (startAddr === null) {
    throw new Error(`bad address: ${positionals[1]}`);
  }
  const count =
    positionals[2] === "all"
      ? Infinity
      : positionals[2]
        ? Math.min(1024, Math.max(1, parseInt(positionals[2], 10) || 16))
        : 16;

  const bytes = new Uint8Array(await readFile(filePath));
  const bytesEnd = base + bytes.length;

  // Build a reader that maps CPU-side addresses to file offsets via
  // (addr - base). Out-of-range reads return 0xFF — same convention
  // the Z80 sees when nothing is mapped at an address.
  const read = (addr: u16): u8 => {
    const off = (addr & 0xffff) - base;
    if (off < 0 || off >= bytes.length) return 0xff;
    return bytes[off]!;
  };

  const romSyms = await loadSymbols(values.syms, filePath, bytes);
  // Optional auxiliary tables — explicit paths only (no auto-detect
  // because RAM and port files belong to a *variant*, not a ROM file).
  const ramSyms = values["ram-syms"]
    ? await loadAuxSymbols(values["ram-syms"])
    : undefined;
  const portSyms = values["port-syms"]
    ? await loadAuxSymbols(values["port-syms"])
    : undefined;

  // Merge: per-ROM first (most specific), then RAM. Wrap the lot in
  // the fuzzy "name+N" resolver so mid-function addresses also
  // surface. Port resolution is a separate channel because port
  // numbers share the u8 namespace with byte values.
  const tables: SymbolTable[] = [];
  if (romSyms) tables.push(romSyms);
  if (ramSyms) tables.push(ramSyms);
  const merged: SymbolTable | undefined =
    tables.length === 0 ? undefined : fuzzySymbolTable(mergeSymbolTables(...tables));

  process.stdout.write(
    `; ${filePath} (${bytes.length} bytes), base=0x${hex(base, 4)}, ` +
      `disassembling ${count} instr from 0x${hex(startAddr, 4)}\n`,
  );

  let pc: u16 = startAddr & 0xffff;
  for (let i = 0; i < count; i++) {
    if (pc >= bytesEnd) break;

    // Print a label header line when this address has its own name.
    // Mirrors typical assembler output and makes function entry
    // points obvious in a long listing. Header only fires on EXACT
    // match — fuzzy `name+N` matches don't get their own line.
    const labelHere = romSyms?.lookup(pc) ?? ramSyms?.lookup(pc);
    if (labelHere) process.stdout.write(`${labelHere}:\n`);

    const opts: Parameters<typeof disassemble>[2] = {};
    if (merged) opts.resolveLabel = merged.lookup;
    if (portSyms) opts.resolvePort = (port) => portSyms.lookup(port & 0xff);
    const d = disassemble(read, pc, opts);
    const bytesStr = d.bytes
      .map((b) => byte(b))
      .join(" ")
      .padEnd(11);
    process.stdout.write(`  ${word(pc)}: ${bytesStr}  ${d.mnemonic}\n`);
    pc = (pc + d.length) & 0xffff;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
