// Standalone runner for zexdoc.com / zexall.com that bypasses vitest's
// stderr buffering. Streams BDOS output to stdout in real time, prints
// progress every 50M instructions, and reports the final outcome.
//
// Usage:
//   tsx tests/programs/zex-runner.ts zexdoc
//   tsx tests/programs/zex-runner.ts zexall

import { Z80 } from "../../src/chips/z80/cpu.js";
import { IOBus } from "../../src/core/IOBus.js";
import { MemoryBus } from "../../src/core/MemoryBus.js";
import type { Milliseconds, Operations, Seconds } from "../../src/flavours.js";
import { formatHMS, RAM64k } from "../tools.js";
import {
  APPROX_TOTAL_OPS,
  loadZEXBinary,
  MAX_OPS,
  SHOW_PROGRESS_EVERY_OPS,
} from "./zex.js";

async function main() {
  const which = process.argv[2] ?? "zexdoc";
  const filename = `${which}.com`;
  const bin = await loadZEXBinary(filename);
  const totalOps = APPROX_TOTAL_OPS[filename];

  const ram = new RAM64k();
  ram.bytes[0x0000] = 0xc9; // RET at warm-boot
  ram.bytes[0x0005] = 0xc9; // RET at BDOS
  for (let i = 0; i < bin.length; i++) ram.bytes[0x0100 + i] = bin[i]!;

  const cpu = new Z80(new MemoryBus([ram], 0xff), new IOBus());
  cpu.regs.PC = 0x0100;
  cpu.regs.SP = 0xff00;

  let ops: Operations = 0;
  const start: Milliseconds = Date.now();
  let lastProgressOps: Operations = 0;

  while (ops < MAX_OPS) {
    if (cpu.regs.PC === 0x0005) {
      const fn = cpu.regs.C;
      if (fn === 0) {
        process.stdout.write("\n[bdos terminate]\n");
        break;
      } else if (fn === 2) {
        process.stdout.write(String.fromCharCode(cpu.regs.E));
      } else if (fn === 9) {
        let addr = cpu.regs.DE;
        for (let i = 0; i < 0x10000; i++) {
          const b = ram.bytes[addr]!;
          if (b === 0x24) break;
          process.stdout.write(String.fromCharCode(b));
          addr = (addr + 1) & 0xffff;
        }
      }
      const lo = ram.bytes[cpu.regs.SP]!;
      const hi = ram.bytes[(cpu.regs.SP + 1) & 0xffff]!;
      cpu.regs.PC = (hi << 8) | lo;
      cpu.regs.SP = (cpu.regs.SP + 2) & 0xffff;
      ops++;
      continue;
    }
    if (cpu.regs.PC === 0x0000) {
      process.stdout.write("\n[warm boot]\n");
      break;
    }
    cpu.runOneOp();
    ops++;
    if (ops - lastProgressOps >= SHOW_PROGRESS_EVERY_OPS) {
      lastProgressOps = ops;
      const sec: Seconds = (Date.now() - start) / 1000;
      const rate = ops / sec;
      const mops = (rate / 1_000_000).toFixed(2);
      let etaPart = "";
      if (totalOps !== undefined && ops < totalOps) {
        const remaining = (totalOps - ops) / rate;
        const pct = ((ops / totalOps) * 100).toFixed(1);
        etaPart = `, ${pct}% done, ETA ~${formatHMS(remaining)}`;
      }
      process.stderr.write(
        `\n[${ops.toLocaleString()} ops, ${sec.toFixed(1)}s, ${mops} Mops/s${etaPart}]\n`,
      );
    }
  }

  const sec: Seconds = (Date.now() - start) / 1000;
  process.stderr.write(
    `\nDone: ${ops.toLocaleString()} ops in ${formatHMS(sec)} ` +
      `(${(ops / sec / 1_000_000).toFixed(2)} Mops/s)\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
