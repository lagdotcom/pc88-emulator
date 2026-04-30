import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";

import ansiRegex from "ansi-regex";
import { config as loadDotEnv } from "dotenv";
import emitter from "log/lib/emitter";
import startNodeLogging from "log-node";

import type { PC88Config } from "./machines/config.js";
import { runDebug } from "./machines/debug.js";
import {
  PC88Machine,
  runMachine,
  type RunOptions,
  type RunResult,
} from "./machines/pc88.js";
import type { LoadedRoms } from "./machines/pc88-memory.js";
import { loadRoms } from "./machines/rom-loader.js";
import { MKI } from "./machines/variants/mk1.js";
import { MKII } from "./machines/variants/mk2.js";
import { MKII_FR } from "./machines/variants/mk2fr.js";
import { MKII_SR } from "./machines/variants/mk2sr.js";
import { hex } from "./tools.js";

const DEFAULT_MAX_OPS = 150_000;

const variants = [MKI, MKII, MKII_SR, MKII_FR];
const variantNames = Object.fromEntries(
  variants.flatMap((mach) => mach.nicknames.map((nick) => [nick, mach])),
);

interface CliFlags {
  config: PC88Config;
  romDir: string;
  maxOps: number;
  traceIo: "off" | "deduped" | "raw";
  rawTvram: boolean;
  logFile: string | null;
  // Optional BASIC override: if set, flips bit 2 of the variant's
  // DIP port31 before machine construction. null leaves the
  // variant's factory default in place.
  basicOverride: "n80" | "n88" | null;
  help: boolean;
  // Drop into the interactive debugger before running anything;
  // user drives execution via step/continue/break/etc.
  debug: boolean;
  // Initial breakpoints to install when --debug is set.
  initialBreakpoints: number[];
}

// Parse CLI flags with env-var fallback so .env still works for
// values you'd want to keep across runs (ROM dir, log file path).
// Boolean-style switches default to off; `--trace-io=raw` opts into
// the unfiltered IO trace, `--trace-io` alone uses dedupe.
function parseCliFlags(argv: string[]): CliFlags {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      machine: { type: "string", short: "m" },
      basic: { type: "string" },
      "rom-dir": { type: "string" },
      "max-ops": { type: "string" },
      "trace-io": { type: "string" },
      "raw-tvram": { type: "boolean" },
      "log-file": { type: "string" },
      debug: { type: "boolean", short: "d" },
      break: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });

  const romDir = values["rom-dir"] ?? process.env.PC88_ROM_DIR ?? "roms";
  const maxOpsRaw = values["max-ops"] ?? process.env.PC88_MAX_OPS;
  const maxOps = maxOpsRaw ? parseInt(maxOpsRaw, 10) : DEFAULT_MAX_OPS;

  // Trace mode: CLI wins over env, "raw" beats "deduped" beats "off".
  const traceRaw = values["trace-io"] ?? process.env.PC88_TRACE_IO ?? null;
  const traceIo: CliFlags["traceIo"] =
    traceRaw === "raw"
      ? "raw"
      : traceRaw === null || traceRaw === "0" || traceRaw === ""
        ? "off"
        : "deduped";

  const rawTvram = !!values["raw-tvram"] || process.env.PC88_RAW_TVRAM === "1";

  // --log-file (bare) and LOG_TO_FILE both default to ./main.log;
  // --log-file=PATH overrides.
  const logFlag = values["log-file"];
  const logFile =
    typeof logFlag === "string" && logFlag.length > 0
      ? logFlag
      : logFlag === "" || process.env.LOG_TO_FILE
        ? "main.log"
        : null;

  const config =
    variantNames[values["machine"]?.toLowerCase() as keyof typeof variantNames];
  if (!config && values["machine"])
    throw new Error(`Unknown machine name: ${values["machine"]}`);

  const basicArg = values["basic"]?.toLowerCase();
  let basicOverride: CliFlags["basicOverride"] = null;
  if (basicArg !== undefined) {
    if (basicArg !== "n80" && basicArg !== "n88") {
      throw new Error(`--basic must be n80 or n88, got ${values["basic"]}`);
    }
    basicOverride = basicArg;
  }

  // Parse --break=ADDR (repeatable) into a list of u16 addresses.
  // Accepts "0xff", "ff", or decimal. Fails fast on bad input so
  // the user notices typos instead of silently dropping a breakpoint.
  const initialBreakpoints: number[] = [];
  const breakArgs = (values["break"] as string[] | undefined) ?? [];
  for (const arg of breakArgs) {
    const a = parseAddrFlag(arg);
    if (a === null) throw new Error(`--break: bad address ${arg}`);
    initialBreakpoints.push(a);
  }

  return {
    romDir,
    maxOps,
    traceIo,
    rawTvram,
    logFile,
    basicOverride,
    help: !!values.help,
    debug: !!values["debug"],
    initialBreakpoints,
    config: config ?? MKI,
  };
}

function parseAddrFlag(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("0x")) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n & 0xffff : null;
  }
  if (/^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) {
    return parseInt(s, 16) & 0xffff;
  }
  const dec = parseInt(s, 10);
  return Number.isFinite(dec) ? dec & 0xffff : null;
}

const HELP = `\
yarn pc88 — boot a PC-88 variant, dump TVRAM after a fixed op budget

  -m, --machine=NAME  machine variant (default: mkI; nicknames: mki,
                      ii, sr, fr, ...)
  --basic=n80|n88     override DIP-switch BASIC selection without
                      editing the variant (n80 = N-BASIC, n88 = N88-BASIC)
  --rom-dir=PATH      ROM directory (default: roms; env: PC88_ROM_DIR)
  --max-ops=N         instruction budget (default: ${DEFAULT_MAX_OPS}; env: PC88_MAX_OPS)
  --trace-io[=raw]    log every IN/OUT with PC; bare flag dedupes
                      consecutive identical lines, =raw shows them all
                      (env: PC88_TRACE_IO=1 / =raw)
  --raw-tvram         always print the 4 KB hex dump after the visible
                      screen (env: PC88_RAW_TVRAM=1)
  --log-file[=PATH]   tee log output to PATH (default: main.log)
                      (env: LOG_TO_FILE=anything → main.log)
  -d, --debug         drop into the interactive debugger before
                      running anything (step / next / continue /
                      break / peek / poke / regs / chips / quit)
  --break=ADDR        install an initial breakpoint at ADDR (hex
                      or decimal); repeatable
  -h, --help          show this help
`;

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

function addFileLogger(path: string) {
  const ws = createWriteStream(path, { encoding: "utf-8" });
  emitter.on("log", (event) => {
    const msg = event.message.replace(ansiRegex(), "");
    ws.write(msg + "\n");
  });
}

async function main(): Promise<void> {
  // .env loads first so process.env is populated before parseCliFlags
  // checks for fallbacks.
  loadDotEnv({ quiet: true });
  const flags = parseCliFlags(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  startNodeLogging();
  if (flags.logFile) addFileLogger(flags.logFile);

  // TODO change signature to { loaded: bool, missing: [] } so this check isn't hard coded here
  const loaded = await loadRoms(flags.config, { dir: flags.romDir });
  // n80 and n88 are required for any PC-88 boot. E-ROM slots E0..E3
  // are optional — the memory map falls back to BASIC ROM
  // continuation when the active slot has no image.
  if (!loaded.n80 || !loaded.n88) {
    throw new Error(
      `${flags.config.model} requires n80 and n88 ROMs in ${flags.romDir}/ (got ${Object.keys(loaded).join(", ")})`,
    );
  }

  // Apply the --basic override (if any) to the variant's DIP byte
  // before constructing the machine. Bit 2 of port31 is the rmode
  // flag: 1 = N-BASIC, 0 = N88-BASIC. Cleanest is to clone the
  // config so the source variant object stays untouched.
  const config: PC88Config = flags.basicOverride
    ? {
        ...flags.config,
        dipSwitches: {
          ...flags.config.dipSwitches,
          port31:
            flags.basicOverride === "n80"
              ? flags.config.dipSwitches.port31 | 0x04
              : flags.config.dipSwitches.port31 & ~0x04,
        },
      }
    : flags.config;

  const machine = new PC88Machine(config, loaded as LoadedRoms);
  machine.reset();

  if (flags.traceIo !== "off") {
    const cpu = machine.cpu;
    const dedupe = flags.traceIo === "deduped";
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

  if (flags.debug) {
    // Hands off control to the REPL. When the user quits we just
    // return — skipping the diagnostics dump that the headless run
    // emits, since the user's been watching state interactively
    // anyway.
    await runDebug(machine, {
      initialBreakpoints: flags.initialBreakpoints,
      loadedRoms: loaded as LoadedRoms,
    });
    return;
  }

  const opts: RunOptions = { maxOps: flags.maxOps };
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
  // it only on --raw-tvram, or when the visible region is empty
  // (nothing programmed → nothing else to look at).
  const visibleEmpty = visible.startsWith("(CRTC not yet programmed");
  if (flags.rawTvram || visibleEmpty) {
    process.stdout.write("\n\n--- Raw TVRAM (4 KB hex) ---\n");
    process.stdout.write(machine.display.rawTvramDump());
  }
  process.stdout.write("\n------------------\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
