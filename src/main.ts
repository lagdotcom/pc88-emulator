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
  lines.push(
    `crtc           : ${crtc.charsPerRow}x${crtc.rowsPerScreen}, ` +
      `attr-pairs/row=${crtc.attrPairsPerRow}, ` +
      `display=${crtc.displayOn ? "on" : "off"}, ` +
      `status=0x${hex(crtc.status, 2)}`,
  );
  lines.push(
    `dmac ch2       : src=0x${hex(dmac.channelAddress(2), 4)} ` +
      `count=${dmac.channelByteCount(2)} ` +
      `(status=0x${hex(dmac.status, 2)})`,
  );
  lines.push(`beeper toggles : ${beeper.toggles}`);
  lines.push(
    `misc ports     : 0xE7 last=${misc.lastE7 ?? "-"} 0xF8 last=${misc.lastF8 ?? "-"}`,
  );

  // TVRAM activity: if any byte is non-zero, the BIOS got far enough
  // to write something into the text plane.
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
  // The visible dump renders only the CRTC+DMAC-fetched region — what
  // a real screen would actually show. Falls back to a placeholder if
  // the BIOS hasn't programmed SET MODE yet.
  const visible = machine.display.toAsciiDump();
  process.stdout.write("\n\n--- Visible screen ---\n");
  process.stdout.write(visible);
  // The raw 4 KB hex+ASCII dump is noisy in the normal "boot
  // succeeded" case — the visible region tells you everything. Show
  // it only when explicitly requested via PC88_RAW_TVRAM=1, or when
  // the visible region is empty (nothing programmed → nothing else
  // to look at).
  const visibleEmpty = visible.startsWith("(CRTC not yet programmed");
  if (process.env.PC88_RAW_TVRAM === "1" || visibleEmpty) {
    process.stdout.write("\n\n--- Raw TVRAM (4 KB hex) ---\n");
    process.stdout.write(machine.display.rawTvramDump());
  }
  process.stdout.write("\n------------------\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
