import { createWriteStream } from "node:fs";

import ansiRegex from "ansi-regex";
import { config as loadDotEnv } from "dotenv";
import emitter from "log/lib/emitter";
import startNodeLogging from "log-node";

import {
  PC88Machine,
  runMachine,
  type RunOptions,
  type RunResult,
} from "./machines/pc88.js";
import type { LoadedRoms } from "./machines/pc88-memory.js";
import { loadRoms } from "./machines/rom-loader.js";
import { MKI } from "./machines/variants/mk1.js";

const DEFAULT_MAX_OPS = 150_000;

function hex(n: number, w: number): string {
  return n.toString(16).padStart(w, "0");
}

// Pretty-print the head of TVRAM as hex+ASCII rows. Useful for catching
// "the BIOS wrote bytes but they're outside the printable range" cases
// — the toAsciiDump() output silently maps non-printables to "·" which
// can hide a partly-initialised banner.
function tvramHexHead(tvram: Uint8Array, lines: number): string {
  const out: string[] = [];
  for (let row = 0; row < lines; row++) {
    const base = row * 16;
    const bytes = Array.from(tvram.subarray(base, base + 16))
      .map((b) => hex(b, 2))
      .join(" ");
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      const b = tvram[base + i]!;
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    }
    out.push(`  ${hex(0xf000 + base, 4)}  ${bytes}  ${ascii}`);
  }
  return out.join("\n");
}

function diagnostics(machine: PC88Machine, result: RunResult): string {
  const { memoryMap, sysctrl, crtc, dmac, beeper, irq, misc, ppi } = machine;
  const lines: string[] = [];

  lines.push(`reason         : ${result.reason}`);
  lines.push(
    `ops / cycles   : ${result.ops.toLocaleString()} / ${result.cycles.toLocaleString()}`,
  );
  lines.push(
    `PC / SP        : 0x${hex(result.finalPC, 4)} / 0x${hex(result.finalSP, 4)}`,
  );
  lines.push(`IFF1 / halted  : ${result.iff1} / ${result.halted}`);
  lines.push(`IM / I         : ${result.im} / 0x${hex(result.iReg, 2)}`);
  lines.push(
    `VBL IRQs       : ${result.vblIrqsRaised} raised, ${result.vblIrqsMasked} masked`,
  );
  lines.push(
    `IRQ mask (E6)  : 0x${hex(irq.mask, 2)} (programmed=${irq.programmed})`,
  );
  lines.push(
    `bank state     : basic=${memoryMap.basicMode} romEnabled=${memoryMap.basicRomEnabled} vram=${memoryMap.vramEnabled} (tvram is permanent at 0xF000)`,
  );
  lines.push(`sys status     : 0x${hex(sysctrl.systemStatus, 2)}`);
  lines.push(`crtc status    : 0x${hex(crtc.status, 2)}`);
  lines.push(`dmac status    : 0x${hex(dmac.status, 2)}`);
  lines.push(`beeper toggles : ${beeper.toggles}`);
  lines.push(
    `misc ports     : 0xE7 last=${misc.lastE7 ?? "-"} 0xF8 last=${misc.lastF8 ?? "-"}`,
  );

  // TVRAM activity: if any byte is non-zero, the BIOS got far enough to
  // write something into the text plane (even if it's not ASCII yet).
  let nonZero = 0;
  let firstNz = -1;
  let lastNz = -1;
  for (let i = 0; i < memoryMap.tvram.length; i++) {
    if (memoryMap.tvram[i] !== 0) {
      nonZero++;
      if (firstNz < 0) firstNz = i;
      lastNz = i;
    }
  }
  if (nonZero === 0) {
    lines.push(`TVRAM          : empty (BIOS never wrote a byte)`);
  } else {
    lines.push(
      `TVRAM          : ${nonZero} non-zero bytes, range [0xF${hex(firstNz, 3)}..0xF${hex(lastNz, 3)}]`,
    );

    // Stride probe: scan for "BASIC" (the most distinctive ASCII run
    // in the N-BASIC banner) at varied byte spacings. The first
    // stride that finds it is the real per-row stride. Common PC-88
    // candidates: 80 (mkI mono, no attrs), 120 (mkI with 40-byte
    // attribute area), 128 (mkI with attrs + padding), 160 (mkII SR
    // interleaved char/attr).
    const tv = memoryMap.tvram;
    const probe = "BASIC";
    const probeBytes = Array.from(probe).map((c) => c.charCodeAt(0));
    const findContiguous = () => {
      for (let i = 0; i + probeBytes.length <= tv.length; i++) {
        let ok = true;
        for (let j = 0; j < probeBytes.length; j++) {
          if (tv[i + j] !== probeBytes[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      return -1;
    };
    const findInterleaved = () => {
      // Same probe but with one byte gap between chars (so
      // 'B' '?' 'A' '?' 'S' '?' 'I' '?' 'C').
      for (let i = 0; i + probeBytes.length * 2 - 1 <= tv.length; i++) {
        let ok = true;
        for (let j = 0; j < probeBytes.length; j++) {
          if (tv[i + j * 2] !== probeBytes[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
      return -1;
    };
    const cont = findContiguous();
    const inter = findInterleaved();
    if (cont >= 0) {
      lines.push(
        `"BASIC"        : 0xF${hex(cont, 3)} (contiguous) → row stride = 80`,
      );
    } else if (inter >= 0) {
      lines.push(
        `"BASIC"        : 0xF${hex(inter, 3)} (interleaved with 1-byte gap) → 160-byte stride or 40-col mode`,
      );
    } else {
      lines.push(`"BASIC"        : not found in TVRAM at any common stride`);
    }

    lines.push(`TVRAM hex head :`);
    lines.push(tvramHexHead(memoryMap.tvram, 4));
  }

  // 32 bytes around the final PC, read through the memory map (so
  // bank-switched ROM/RAM contents reflect what the CPU actually sees
  // at the moment of stop). Useful for "what's the BIOS executing in
  // this loop?" — paste the bytes into a Z80 disassembler to see.
  const pc = result.finalPC;
  const pcLo = Math.max(0, pc - 4);
  const pcHi = Math.min(0xffff, pc + 28);
  const surroundBytes: string[] = [];
  for (let a = pcLo; a <= pcHi; a++) {
    const tag = a === pc ? ">" : " ";
    if ((a - pcLo) % 8 === 0) surroundBytes.push(`\n  ${hex(a, 4)} ${tag}`);
    else surroundBytes.push(tag);
    surroundBytes.push(hex(machine.memBus.read(a), 2));
  }
  lines.push(`bytes @ PC     :${surroundBytes.join(" ")}`);

  void ppi; // PPI is just a logger right now; keep destructure stable.
  return lines.join("\n");
}

function addFileLogger() {
  const ws = createWriteStream("main.log", { encoding: "utf-8" });
  emitter.on("log", (event) => {
    const msg = event.message.replace(ansiRegex(), "");
    ws.write(msg + "\n");
  });
}

async function main(): Promise<void> {
  loadDotEnv({ quiet: true });
  startNodeLogging();
  if (process.env.LOG_TO_FILE) addFileLogger();

  const dir = process.env.PC88_ROM_DIR ?? "roms";
  const loaded = await loadRoms(MKI, { dir });
  if (!loaded.n80 || !loaded.n88 || !loaded.e0) {
    throw new Error(
      `mkI requires n80, n88, e0 ROMs in ${dir}/ (got ${Object.keys(loaded).join(", ")})`,
    );
  }
  const roms: LoadedRoms = {
    n80: loaded.n80,
    n88: loaded.n88,
    e0: loaded.e0,
  };

  const machine = new PC88Machine(MKI, roms);
  machine.reset();

  // PC88_TRACE_IO=1 logs every IN/OUT with the CPU PC at the time of
  // the access. Consecutive identical lines collapse into a single
  // "(× N times)" report so that tight polling loops don't drown the
  // log. Set PC88_TRACE_IO=raw to disable the dedupe.
  const traceMode = process.env.PC88_TRACE_IO ?? "";
  if (traceMode === "1" || traceMode === "raw") {
    const cpu = machine.cpu;
    const dedupe = traceMode === "1";
    let last: string | null = null;
    let lastCount = 0;
    const flush = () => {
      if (lastCount > 1) console.log(`  (× ${lastCount} times)`);
    };
    machine.ioBus.tracer = (kind, port, value) => {
      const pc = cpu.regs.PC;
      const dir = kind === "r" ? "IN " : "OUT";
      const line = `[io] PC=0x${hex(pc, 4)} ${dir} 0x${hex(port & 0xff, 2)} = 0x${hex(value, 2)}`;
      if (dedupe && line === last) {
        lastCount++;
        return;
      }
      flush();
      console.log(line);
      last = line;
      lastCount = 1;
    };
    process.on("exit", flush);
  }

  const opts: RunOptions = {
    maxOps: parseInt(process.env.PC88_MAX_OPS ?? `${DEFAULT_MAX_OPS}`, 10),
  };
  const result = runMachine(machine, opts);

  process.stdout.write("\n--- Diagnostics ---\n");
  process.stdout.write(diagnostics(machine, result));
  process.stdout.write("\n\n--- TVRAM dump ---\n");
  process.stdout.write(machine.display.toAsciiDump());
  process.stdout.write("\n------------------\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
