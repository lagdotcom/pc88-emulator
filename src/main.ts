import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { config as loadDotEnv } from "dotenv";

import { runDebug } from "./debug/debug-cli.js";
import { parseD88 } from "./disk/d88.js";
import { kOps } from "./flavour.makers.js";
import type { FilesystemPath, Operations, u16 } from "./flavours.js";
import { logToStream } from "./log.js";
import type { PC88Config } from "./machines/config.js";
import {
  PC88Machine,
  runMachine,
  type RunOptions,
  type RunResult,
} from "./machines/pc88.js";
import { pixelFrameToPNG } from "./machines/pc88-screenshot.js";
import { loadRoms } from "./machines/rom-loader.js";
import { VARIANTS_BY_NICKNAME } from "./machines/variants/index.js";
import { MKI } from "./machines/variants/mk1.js";
import { hex, parseAddrFlag, parseSICount } from "./tools.js";

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
  // Optional path for --screenshot=PATH. After the run finishes the
  // composited pixel frame (GVRAM + text overlay if font ROM was
  // loaded) is written as a PPM (P6) file at this location.
  screenshot: FilesystemPath | null;
  // Optional path for --disk0=PATH.d88. Loads + parses the D88,
  // force-enables the disk subsystem (overriding the variant
  // config's hasSubCpu), and inserts the first image into drive 0.
  // Multi-image D88s use only the first image; the rest are ignored
  // until a multi-disk swap UI lands.
  disk0: FilesystemPath | null;
  // High-level structured trace of the sub-CPU IPC bridge. Decodes
  // the PPI byte exchanges into command-byte / parameter / response
  // events tagged by ATN state, and surfaces FDC command dispatch
  // / parameter accumulation / result phase / IRQ assert. Much
  // easier to read than `--trace-io` for disk-boot debugging where
  // most port traffic is the PPI handshake polling loops.
  traceIpc: boolean;
  // Boot mode override. "rom" (default) leaves DIP port31 bit 1
  // (MMODE) clear so the BIOS runs N88/N-BASIC from ROM and the
  // user gets the "How many files?" prompt. "disk" flips MMODE=1
  // (and clears RMODE so N88-DISK-BASIC is the active variant) so
  // the BIOS takes the disk-boot path: load the boot sector,
  // unmap the BASIC ROM via a port-0x31 write, jump to RAM. Only
  // useful when --disk0 is also set.
  bootMode: "rom" | "disk";
  // Arbitrary DIP override. The variant config provides factory
  // defaults; --basic= and --boot= flip specific bits on top.
  // --dip30=NN / --dip31=NN replace the byte wholesale (after the
  // other overrides have done their work), so power users can
  // experiment with bits that don't have a friendlier flag — e.g.
  // port31 bit 7 selects between V1 and V2 video mode on SR
  // (`--dip31=0x69` for V2 with N88 + 200-line + GRPH +
  // HIGHRES, vs the SR default 0xE9). Null = no override.
  dip30Override: number | null;
  dip31Override: number | null;
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
      screenshot: { type: "string" },
      disk0: { type: "string" },
      "trace-ipc": { type: "boolean" },
      boot: { type: "string" },
      dip30: { type: "string" },
      dip31: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const romDir = values["rom-dir"] ?? process.env.PC88_ROM_DIR ?? "roms";
  const maxOpsRaw = values["max-ops"] ?? process.env.PC88_MAX_OPS;
  const maxOps = maxOpsRaw
    ? (parseSICount(maxOpsRaw) ?? DEFAULT_MAX_OPS)
    : DEFAULT_MAX_OPS;

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

  const screenshotArg =
    values["screenshot"] ?? process.env.PC88_SCREENSHOT ?? null;
  const screenshot: FilesystemPath | null =
    typeof screenshotArg === "string" && screenshotArg.length > 0
      ? screenshotArg
      : null;

  const disk0Arg = values["disk0"] ?? process.env.PC88_DISK0 ?? null;
  const disk0: FilesystemPath | null =
    typeof disk0Arg === "string" && disk0Arg.length > 0 ? disk0Arg : null;

  const traceIpc =
    !!values["trace-ipc"] || process.env.PC88_TRACE_IPC === "1";

  const bootArg =
    (values["boot"] ?? process.env.PC88_BOOT ?? "rom").toLowerCase();
  if (bootArg !== "rom" && bootArg !== "disk") {
    throw new Error(`--boot must be "rom" or "disk", got ${bootArg}`);
  }
  const bootMode: CliFlags["bootMode"] = bootArg;

  // --dip30 / --dip31 wholesale overrides. Accept hex (`0xff`,
  // `ff`) or decimal. Null when the flag isn't passed; the
  // composing logic below applies after --basic= / --boot= so a
  // raw byte override stays the final word.
  const parseDipFlag = (flag: string | undefined): number | null => {
    const raw = flag ?? null;
    if (raw === null || raw === "") return null;
    const a = parseAddrFlag(raw);
    if (a === null) {
      throw new Error(`bad DIP byte: ${raw}`);
    }
    return a & 0xff;
  };
  const dip30Override = parseDipFlag(
    values["dip30"] ?? process.env.PC88_DIP30,
  );
  const dip31Override = parseDipFlag(
    values["dip31"] ?? process.env.PC88_DIP31,
  );

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
    screenshot,
    disk0,
    traceIpc,
    bootMode,
    dip30Override,
    dip31Override,
    config,
  };
}

const HELP = `\
yarn pc88 — boot a PC-88 variant, dump TVRAM after a fixed op budget

  -m, --machine=NAME  machine variant (default: mkI; nicknames: mki,
                      ii, sr, fr, ...)
  --basic=n80|n88     override DIP-switch BASIC selection without
                      editing the variant (n80 = N-BASIC, n88 = N88-BASIC)
  --rom-dir=PATH      ROM directory (default: roms; env: PC88_ROM_DIR)
  --max-ops=N         instruction budget (default: ${DEFAULT_MAX_OPS}; env: PC88_MAX_OPS)
                      accepts SI suffixes: 50M = 50000000, 60k = 60000, 1.5G = 1.5e9
  --trace-io[=raw]    log every IN/OUT with PC; bare flag dedupes
                      consecutive identical lines, =raw shows them all
                      (env: PC88_TRACE_IO=1 / =raw)
  --trace-ipc         high-level structured trace of the sub-CPU IPC
                      bridge: PPI byte exchanges tagged cmd/param/
                      response by ATN state, plus FDC command dispatch
                      / params / result / IRQ. Use for disk-boot work
                      (env: PC88_TRACE_IPC=1)
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
  --screenshot=PATH   after the run, write the composited frame
                      (GVRAM + text overlay when font.rom is loaded)
                      as a PNG file at PATH (env: PC88_SCREENSHOT)
  --disk0=PATH.d88    load a D88 disk image and insert it into
                      drive 0; force-enables the disk subsystem
                      (the FDC sub-CPU + drives) regardless of the
                      variant's hasSubCpu — needed for mkI to use
                      its PC-8031 external floppy unit
                      (env: PC88_DISK0)
  --boot=rom|disk     ROM (default): N-/N88-BASIC from ROM, "How
                      many files?" prompt. disk: flip DIP port31
                      bit 1 (MMODE) so the BIOS takes the disk-
                      boot path. Only useful when --disk0= is set
                      (env: PC88_BOOT)
  --dip30=NN          override DIP port30 byte (hex 0xNN, ff, or
                      decimal). Replaces the variant default
                      AFTER --basic / --boot have done their work
                      (env: PC88_DIP30)
  --dip31=NN          override DIP port31 byte. Same shape as
                      --dip30. Useful for bits without a friendlier
                      flag — port31 bit 7 selects V1/V2 video mode
                      on SR; port31 bit 5 toggles HIGHRES; etc.
                      Bit map: 0=LINES_200, 1=MMODE, 2=RMODE_N80,
                      3=GRPH, 4=HCOLOR, 5=HIGHRES, 6/7 model-specific
                      (env: PC88_DIP31)
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

  // Apply per-feature DIP overrides (--basic, --boot) to the
  // variant's DIP byte before constructing the machine, then a
  // wholesale --dip30= / --dip31= override on top. Bit 2 of port31
  // is the rmode flag (1 = N-BASIC, 0 = N88-BASIC); bit 1 is MMODE.
  // Cleanest is to clone the config so the source variant object
  // stays untouched.
  let port30 = flags.config.dipSwitches.port30;
  let port31 = flags.config.dipSwitches.port31;
  if (flags.basicOverride === "n80") port31 |= 0x04;
  if (flags.basicOverride === "n88") port31 &= ~0x04;
  if (flags.bootMode === "disk") port31 |= 0x02;
  if (flags.bootMode === "rom") port31 &= ~0x02;
  // Wholesale overrides win — they replace the byte after the
  // per-feature flags above have done their work, so power users
  // can experiment with bits that don't have a friendlier flag
  // (e.g. port31 bit 7 for SR's V1/V2 video-mode select).
  if (flags.dip30Override !== null) port30 = flags.dip30Override;
  if (flags.dip31Override !== null) port31 = flags.dip31Override;
  const config: PC88Config =
    port30 !== flags.config.dipSwitches.port30 ||
    port31 !== flags.config.dipSwitches.port31
      ? {
          ...flags.config,
          dipSwitches: { ...flags.config.dipSwitches, port30, port31 },
        }
      : flags.config;

  const machine = new PC88Machine(config, loaded, {
    enableDiskSubsystem: flags.disk0 !== null,
  });
  machine.reset();

  if (flags.disk0) {
    const bytes = readFileSync(flags.disk0);
    const disks = parseD88(
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    if (disks.length === 0) {
      throw new Error(`--disk0: ${flags.disk0} contains no D88 images`);
    }
    machine.insertDisk(0, disks[0]!);
    process.stdout.write(
      `--- Disk 0 ---\nloaded ${flags.disk0}: ${disks[0]!.name || "(no name)"} ` +
        `${disks[0]!.mediaType} ${disks[0]!.cylinders}×${disks[0]!.heads}\n`,
    );
  }

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

  if (flags.traceIpc) {
    const cpu = machine.cpu;
    if (machine.ppi) {
      machine.ppi.tracer = (e) => {
        const pc = `0x${hex(cpu.regs.PC, 4)}`;
        if (e.kind === "data") {
          const tag = e.atnAsserted ? "CMD/AT" : "data  ";
          const arrow = e.side === "main" ? "main→sub" : "sub→main";
          console.log(
            `[ipc] PC=${pc} ${arrow} ${tag} port-${e.port} = 0x${hex(e.value, 2)}`,
          );
        } else {
          const op = e.set ? "SET" : "CLR";
          console.log(
            `[ipc] PC=${pc} ${e.side.padEnd(4)} ctrl ${op} ${e.mnemonic} (bit ${e.bit})`,
          );
        }
      };
    }
    if (machine.subcpu?.fdc) {
      machine.subcpu.fdc.tracer = (e) => {
        const subpc = `0x${hex(machine.subcpu!.cpu.regs.PC, 4)}`;
        switch (e.kind) {
          case "cmd-start":
            console.log(
              `[fdc] subpc=${subpc} CMD ${e.name} (0x${hex(e.cmd, 2)}, ${e.expectedParams} params)`,
            );
            break;
          case "param":
            console.log(
              `[fdc] subpc=${subpc} param[${e.index}] = 0x${hex(e.value, 2)}`,
            );
            break;
          case "execute":
            console.log(
              `[fdc] subpc=${subpc} EXEC ${e.name} drive=${e.drive} head=${e.head}`,
            );
            break;
          case "result":
            console.log(
              `[fdc] subpc=${subpc} RESULT [${e.bytes.map((b) => `0x${hex(b, 2)}`).join(" ")}]`,
            );
            break;
          case "irq":
            console.log(`[fdc] subpc=${subpc} IRQ`);
            break;
        }
      };
    }
  }

  if (flags.debug) {
    // Hands off control to the REPL. When the user quits we just
    // return — skipping the diagnostics dump that the headless run
    // emits, since the user's been watching state interactively
    // anyway.
    const debugOpts: Parameters<typeof runDebug>[1] = {
      initialBreakpoints: flags.initialBreakpoints,
      loadedRoms: loaded,
      saveScreenshot: (frame, path) => {
        writeFileSync(path, pixelFrameToPNG(frame));
      },
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
  if (flags.screenshot) {
    const frame = machine.display.getPixelFrame();
    if (frame) {
      writeFileSync(flags.screenshot, pixelFrameToPNG(frame));
      process.stdout.write(
        `\n--- Screenshot ---\nwrote ${frame.width}x${frame.height} PNG to ${flags.screenshot}\n`,
      );
    } else {
      process.stdout.write(
        "\n--- Screenshot ---\n(getPixelFrame returned null; nothing written)\n",
      );
    }
  }

  process.stdout.write("\n------------------\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
