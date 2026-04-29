// Standalone runner for zexdoc.com / zexall.com that bypasses vitest's
// stderr buffering. Streams BDOS output to stdout in real time, prints
// progress every 50M instructions, and reports the final outcome.
//
// Usage:
//   tsx tests/programs/zex-runner.ts zexdoc
//   tsx tests/programs/zex-runner.ts zexall

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Z80 } from "../../src/chips/z80/cpu.js";
import { MemoryBus, type MemoryProvider } from "../../src/core/MemoryBus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const URLS: Record<string, string> = {
  "zexdoc.com":
    "https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexdoc.com",
  "zexall.com":
    "https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexall.com",
};

// Approximate total instructions to completion. Used only for the ETA in
// progress logs — the actual run terminates on BDOS function 0 from the
// binary itself, not on hitting this count. Numbers come from a measured
// run on this emulator (~5.78 G ops to a clean exit, regardless of
// whether the test reports ERROR or ok). Refresh if the emulator's
// behaviour changes enough that these get noticeably off.
const APPROX_TOTAL_OPS: Record<string, number> = {
  "zexdoc.com": 5_800_000_000,
  "zexall.com": 5_800_000_000,
};

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

async function loadBinary(name: string): Promise<Uint8Array> {
  const cached = join(FIXTURES, name);
  if (existsSync(cached)) {
    return new Uint8Array(await readFile(cached));
  }
  const url = URLS[name];
  if (!url) throw new Error(`no URL configured for ${name}`);
  console.error(`fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(FIXTURES, { recursive: true });
  await writeFile(cached, buf);
  return buf;
}

class Ram implements MemoryProvider {
  name = "ram";
  start = 0;
  end = 0x10000;
  bytes = new Uint8Array(0x10000);
  read(o: number) {
    return this.bytes[o]!;
  }
  write(o: number, v: number) {
    this.bytes[o] = v;
  }
}

class Io implements MemoryProvider {
  name = "io";
  start = 0;
  end = 0x10000;
  read() {
    return 0xff;
  }
  write() {}
}

async function main() {
  const which = process.argv[2] ?? "zexdoc";
  const filename = `${which}.com`;
  const bin = await loadBinary(filename);
  const totalOps = APPROX_TOTAL_OPS[filename];

  const ram = new Ram();
  const io = new Io();
  ram.bytes[0x0000] = 0xc9; // RET at warm-boot
  ram.bytes[0x0005] = 0xc9; // RET at BDOS
  for (let i = 0; i < bin.length; i++) ram.bytes[0x0100 + i] = bin[i]!;

  const cpu = new Z80(new MemoryBus([ram], 0xff), new MemoryBus([io], 0xff));
  cpu.regs.PC = 0x0100;
  cpu.regs.SP = 0xff00;

  let ops = 0;
  const start = Date.now();
  let lastProgressOps = 0;
  const progressEvery = 50_000_000;
  const max = 20_000_000_000;

  while (ops < max) {
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
    if (ops - lastProgressOps >= progressEvery) {
      lastProgressOps = ops;
      const sec = (Date.now() - start) / 1000;
      const rate = ops / sec;
      const mops = (rate / 1_000_000).toFixed(2);
      let etaPart = "";
      if (totalOps !== undefined && ops < totalOps) {
        const remaining = (totalOps - ops) / rate;
        const pct = ((ops / totalOps) * 100).toFixed(1);
        etaPart = `, ${pct}% done, ETA ~${formatDuration(remaining)}`;
      }
      process.stderr.write(
        `\n[${ops.toLocaleString()} ops, ${sec.toFixed(1)}s, ${mops} Mops/s${etaPart}]\n`,
      );
    }
  }

  const sec = (Date.now() - start) / 1000;
  process.stderr.write(
    `\nDone: ${ops.toLocaleString()} ops in ${formatDuration(sec)} ` +
      `(${(ops / sec / 1_000_000).toFixed(2)} Mops/s)\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
