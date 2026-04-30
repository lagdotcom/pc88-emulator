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
// The optional <addr> is a CPU-side address — the file is accessed
// at offset (addr - base). Hex (0x... / trailing letters) and
// decimal both work.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { disassemble } from "./chips/z80/disasm.js";
import { byte, hex, word } from "./tools.js";

const HELP = `\
yarn dis — disassemble bytes from a raw ROM file as Z80 code

  yarn dis [options] <file> [<addr> [<count>]]

Options:
  --base=ADDR    address the file is "loaded at" (default 0). The
                 file is read at offset (addr - base); JR / JP / CALL
                 targets render in the same address space.
  -h, --help     this help

Positional args:
  <file>      path to the ROM / binary
  [addr]      starting CPU-side address (default = base)
  [count]     number of instructions (default 16, max 1024)

Examples:
  yarn dis roms/mkI-n80.rom 0x0000 32
  yarn dis --base=0x6000 roms/mkI-e0.rom 0x6010 16
`;

function parseAddrFlag(raw: string): number | null {
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      base: { type: "string" },
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
  const count = positionals[2]
    ? Math.min(1024, Math.max(1, parseInt(positionals[2], 10) || 16))
    : 16;

  const bytes = new Uint8Array(await readFile(filePath));

  // Build a reader that maps CPU-side addresses to file offsets via
  // (addr - base). Out-of-range reads return 0xFF — same convention
  // the Z80 sees when nothing is mapped at an address.
  const read = (addr: number): number => {
    const off = (addr & 0xffff) - base;
    if (off < 0 || off >= bytes.length) return 0xff;
    return bytes[off]!;
  };

  process.stdout.write(
    `; ${filePath} (${bytes.length} bytes), base=0x${hex(base, 4)}, ` +
      `disassembling ${count} instr from 0x${hex(startAddr, 4)}\n`,
  );

  let pc = startAddr & 0xffff;
  for (let i = 0; i < count; i++) {
    const d = disassemble(read, pc);
    const bytesStr = d.bytes.map((b) => byte(b)).join(" ").padEnd(11);
    process.stdout.write(`  ${word(pc)}: ${bytesStr}  ${d.mnemonic}\n`);
    pc = (pc + d.length) & 0xffff;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
