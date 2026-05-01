import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";

import { config as loadDotEnv } from "dotenv";

import { kOps } from "./flavour.makers.js";
import type { FilesystemPath, Operations, u16 } from "./flavours.js";
import { logToStream } from "./log.js";
import type { PC88Config } from "./machines/config.js";
import { runDebug } from "./machines/debug-cli.js";
import {
  PC88Machine,
  runMachine,
  type RunOptions,
  type RunResult,
} from "./machines/pc88.js";
import { loadRoms } from "./machines/rom-loader.js";
import { VARIANTS_BY_NICKNAME } from "./machines/variants/index.js";
import { MKI } from "./machines/variants/mk1.js";
import { hex } from "./tools.js";

const DEFAULT_MAX_OPS = kOps(15);

interface CliFlags {
  config: PC88Config;
  romDir: FilesystemPath;
  maxOps: Operations;
  traceIo: "off" | "deduped" | "raw";
  rawTvram: boolean;
  logFile: FilesystemPath | null;
  // Optional BASIC override: if set, flips bit 2 of the variant's
  // DIP port31 before machine construction. null leaves the
  // variant's factory default in place.
  basicOverride: "n80" | "n88" | null;
  help: boolean;
  // Drop into the interactive debugger before running anything;
  // user drives execution via step/continue/break/etc.
  debug: boolean;
  // Initial breakpoints to install when --debug is set.
  initialBreakpoints: u16[];
  // Optional debugger-command script. When set, --debug is implied —
  // running boot scripts without entering the REPL would otherwise
  // be a confusing no-op flag.
  debugScript: FilesystemPath | null;
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
      script: { type: "string" },
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

  const config = values["machine"]
    ? VARIANTS_BY_NICKNAME[values["machine"].toLowerCase()]
    : MKI;
  if (!config) throw new Error(`Unknown machine name: ${values["machine"]}`);

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
  const initialBreakpoints: u16[] = [];
  const breakArgs = (values["break"] as string[] | undefined) ?? [];
  for (const arg of breakArgs) {
    const a = parseAddrFlag(arg);
    if (a === null) throw new Error(`--break: bad address ${arg}`);
    initialBreakpoints.push(a);
  }

  const scriptArg = values["script"] ?? process.env.PC88_SCRIPT ?? null;
  const debugScript: FilesystemPath | null =
    typeof scriptArg === "string" && scriptArg.length > 0 ? scriptArg : null;

  return {
    romDir,
    maxOps,
    traceIo,
    rawTvram,
    logFile,
    basicOverride,
    help: !!values.help,
    // --script implies --debug: the only thing the script can drive
    // is the debugger REPL, so allowing them to be set independently
    // would be a footgun.
    debug: !!values["debug"] || debugScript !== null,
    initialBreakpoints,
    debugScript,
    config,
  };
}

function parseAddrFlag(raw: string): u16 | null {
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
  --script=PATH       replay a debugger-command script before
                      handing control to the REPL; if the script
                      ends with \`quit\` the REPL is skipped (implies
                      --debug; env: PC88_SCRIPT)
  -h, --help          show this help
`;

function diagnostics(machine: PC88Machine, result: RunResult): string {
  const { memoryMap, sysctrl, crtc, dmac, beeper, irq, misc, keyboard } =
    machine;
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
    `bank state     : basic=${memoryMap.basicMode} basic=${memoryMap.basicROMEnabled} erom=${memoryMap.eromSlot}/${memoryMap.eromEnabled} vram=${memoryMap.vramEnabled} (tvram is permanent at 0xF000)`,
  );
  lines.push(`sys status     : 0x${hex(sysctrl.systemStatus, 2)}`);
  lines.push(
    `crtc           : ${crtc.charsPerRow}-byte run × ${crtc.rowsPerScreen} rows ` +
      `(${sysctrl.cols80 ? "80-col 1-byte cells" : "40-col 2-byte cells"}, ` +
      `dma=${crtc.dmaCharMode ? "char" : "burst"}, ` +
      `gfx=${crtc.gfxMode.toString(2).padStart(3, "0")}, ` +
      `attr-pairs/row=${crtc.attrPairsPerRow}, ` +
      `display=${crtc.displayOn ? "on" : "off"}, ` +
      `status=0x${hex(crtc.status, 2)})`,
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
      `TVRAM          : ${nonZero} non-zero bytes, range [0xf${hex(firstNz, 3)}..0xf${hex(lastNz, 3)}]`,
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

  void keyboard; // Keyboard rows are read-only stubs right now; keep destructure stable.
  return lines.join("\n");
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
  if (flags.logFile)
    logToStream(createWriteStream(flags.logFile, { encoding: "utf-8" }));

  // loadRoms throws RomLoadError if a required ROM (per the manifest's
  // `required: true` flag) is missing or fails md5/size validation, so
  // the returned LoadedROMs has its required slots (n80, n88) typed
  // as definitely-present. No runtime null-check needed here.
  const loaded = await loadRoms(flags.config, { dir: flags.romDir });

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

  const machine = new PC88Machine(config, loaded);
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
    const debugOpts: Parameters<typeof runDebug>[1] = {
      initialBreakpoints: flags.initialBreakpoints,
      loadedRoms: loaded,
    };
    if (flags.debugScript !== null) debugOpts.script = flags.debugScript;
    await runDebug(machine, debugOpts);
    return;
  }

  const opts: RunOptions = { maxOps: flags.maxOps };
  const result = runMachine(machine, opts);

  process.stdout.write("\n--- Diagnostics ---\n");
  process.stdout.write(diagnostics(machine, result));
  // The visible dump renders only the CRTC+DMAC-fetched region — what
  // a real screen would actually show. Falls back to a placeholder if
  // the BIOS hasn't programmed SET MODE yet.
  const visible = machine.display.toASCIIDump();
  process.stdout.write("\n\n--- Visible screen ---\n");
  process.stdout.write(visible);
  // The raw 4 KB hex+ASCII dump is noisy in the normal "boot
  // succeeded" case — the visible region tells you everything. Show
  // it only on --raw-tvram, or when the visible region is empty
  // (nothing programmed → nothing else to look at).
  const visibleEmpty = visible.startsWith("(CRTC not yet programmed");
  if (flags.rawTvram || visibleEmpty) {
    process.stdout.write("\n\n--- Raw TVRAM (4 KB hex) ---\n");
    process.stdout.write(machine.display.rawTVRAMDump());
  }
  process.stdout.write("\n------------------\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
