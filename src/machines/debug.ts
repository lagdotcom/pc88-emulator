import { createInterface } from "node:readline/promises";

import logLib from "log";

import { byte, word } from "../tools.js";
import { PC88Machine, makeVblState, pumpVbl, stepOneInstruction } from "./pc88.js";

const log = logLib.get("debug");

// Cap on instructions executed by `continue` / step-over to keep a
// runaway BIOS from locking up the REPL. ~5M is comfortably more
// than a full N-BASIC banner takes.
const CONTINUE_MAX_OPS = 5_000_000;

export interface DebugOptions {
  // Optional initial breakpoint addresses. CLI passes the parsed
  // `--break=ADDR` here.
  initialBreakpoints?: number[];
}

interface DebugState {
  breakpoints: Set<number>;
  ops: number;
  vbl: ReturnType<typeof makeVblState>;
  // Set during step-over: target PC where execution should pause if
  // it returns from the called subroutine. null means "no pending
  // step-over".
  stepOverTarget: number | null;
}

const HELP = `\
Debugger commands (anything in <> takes a hex address; "0x" optional):

  s, step                 single-step one instruction
  n, next                 step over (CALL/RST → run until after the call)
  c, continue             run until breakpoint / halt / op cap
  b, break <addr>         add a breakpoint at <addr>
  bd, unbreak <addr>      remove a breakpoint
  bl, breaks              list breakpoints
  r, regs                 show CPU registers
  chips                   show CRTC / DMAC / IRQ / sysctrl / DIP state
  p, peek <addr> [count]  read N bytes (default 1) at <addr>
  pw, peekw <addr>        read 16-bit little-endian word at <addr>
  poke <addr> <value>     write a byte
  q, quit                 exit
  h, ?, help              this help
`;

// Hex parser that accepts "0xff", "ff", or decimal "255".
function parseAddr(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s.startsWith("0x")) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n & 0xffff : null;
  }
  if (/^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) {
    return parseInt(s, 16) & 0xffff;
  }
  // All-decimal-digit input is decimal; "ff" with letters is hex.
  const dec = parseInt(s, 10);
  if (!isNaN(dec)) return dec & 0xffff;
  const hex = parseInt(s, 16);
  return Number.isFinite(hex) ? hex & 0xffff : null;
}

// CALL family — return (1) bytes consumed, or null if not a CALL.
// Conditional CALL Cc, RST p both included. CALL inside DD/FD/CB
// prefix isn't a thing; we check the unprefixed byte at PC.
function callOpLength(opcode: number): number | null {
  // Unconditional CALL: 0xCD, 3 bytes
  if (opcode === 0xcd) return 3;
  // Conditional CALL Cc: 0xC4 / CC / D4 / DC / E4 / EC / F4 / FC, 3 bytes
  if ((opcode & 0xc7) === 0xc4) return 3;
  // RST p: 0xC7 / CF / D7 / DF / E7 / EF / F7 / FF, 1 byte
  if ((opcode & 0xc7) === 0xc7) return 1;
  return null;
}

function printRegs(machine: PC88Machine): void {
  const snap = machine.snapshot().cpu;
  const f = snap.AF & 0xff;
  const flagStr =
    (f & 0x80 ? "S" : "-") +
    (f & 0x40 ? "Z" : "-") +
    (f & 0x20 ? "Y" : "-") +
    (f & 0x10 ? "H" : "-") +
    (f & 0x08 ? "X" : "-") +
    (f & 0x04 ? "P" : "-") +
    (f & 0x02 ? "N" : "-") +
    (f & 0x01 ? "C" : "-");
  process.stdout.write(
    `  PC=${word(snap.PC)} SP=${word(snap.SP)} AF=${word(snap.AF)} (${flagStr})\n` +
      `  BC=${word(snap.BC)} DE=${word(snap.DE)} HL=${word(snap.HL)} IX=${word(snap.IX)} IY=${word(snap.IY)}\n` +
      `  AF'=${word(snap.AF_)} BC'=${word(snap.BC_)} DE'=${word(snap.DE_)} HL'=${word(snap.HL_)}\n` +
      `  I=${byte(snap.I)} R=${byte(snap.R)} IFF1=${snap.iff1 ? 1 : 0} IFF2=${snap.iff2 ? 1 : 0} IM=${snap.im} halted=${snap.halted ? 1 : 0}\n` +
      `  cycles=${snap.cycles}\n`,
  );
}

// Reads everything off `machine.snapshot()` so the same plumbing
// the debugger uses for display can drive a future savestate writer.
function printChips(machine: PC88Machine): void {
  const snap = machine.snapshot();
  const dmac = machine.dmac;
  const cfg = machine.config;
  process.stdout.write(
    `  variant      : ${cfg.model}\n` +
      `  basic mode   : ${snap.memoryMap.basicMode} (rom enabled=${snap.memoryMap.basicRomEnabled}, eromSlot=${snap.memoryMap.eromSlot})\n` +
      `  vram window  : ${snap.memoryMap.vramEnabled ? "on" : "off"}\n` +
      `  DIP 30/31    : ${byte(cfg.dipSwitches.port30)} / ${byte(cfg.dipSwitches.port31)}\n` +
      `  sys status   : ${byte(snap.sysctrl.systemStatus)} (DIP1=${byte(snap.sysctrl.dipSwitch1)} DIP2=${byte(snap.sysctrl.dipSwitch2)})\n` +
      `  crtc         : ${snap.crtc.charsPerRow}x${snap.crtc.rowsPerScreen} ` +
      `(attr-pairs/row=${snap.crtc.attrPairsPerRow}, ` +
      `display=${snap.crtc.displayOn ? "on" : "off"}, ` +
      `status=${byte(snap.crtc.status)})\n` +
      `  dmac ch2     : src=${word(dmac.channelAddress(2))} count=${dmac.channelByteCount(2)}\n` +
      `  irq          : mask=${byte(snap.irq.mask)} (programmed=${snap.irq.programmed}) priority=${byte(snap.irq.priority)}\n` +
      `  beeper       : ${snap.beeper.toggles} toggles\n` +
      `  misc latches : 0xE7=${snap.misc.lastE7 ?? "-"} 0xF8=${snap.misc.lastF8 ?? "-"}\n`,
  );
}

// One-line summary printed before each prompt: PC, current opcode
// byte, and a hint about whether it's a CALL/RST (so the user can
// tell at a glance whether `next` will skip or just step).
function printPromptSummary(machine: PC88Machine): void {
  const cpu = machine.cpu;
  const pc = cpu.regs.PC;
  const op = machine.memBus.read(pc);
  const next1 = machine.memBus.read((pc + 1) & 0xffff);
  const next2 = machine.memBus.read((pc + 2) & 0xffff);
  const callLen = callOpLength(op);
  const annot = callLen !== null ? ` (${callLen}-byte CALL/RST)` : "";
  process.stdout.write(
    `  @ ${word(pc)}: ${byte(op)} ${byte(next1)} ${byte(next2)}${annot}\n`,
  );
}

function doPeek(machine: PC88Machine, addr: number, count: number): void {
  let line = `  ${word(addr)}:`;
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 16 === 0) {
      process.stdout.write(line + "\n");
      line = `  ${word((addr + i) & 0xffff)}:`;
    }
    line += " " + byte(machine.memBus.read((addr + i) & 0xffff));
  }
  process.stdout.write(line + "\n");
}

function doPeekWord(machine: PC88Machine, addr: number): void {
  const lo = machine.memBus.read(addr & 0xffff);
  const hi = machine.memBus.read((addr + 1) & 0xffff);
  const w = ((hi << 8) | lo) & 0xffff;
  process.stdout.write(
    `  ${word(addr)}: ${byte(lo)} ${byte(hi)}  (LE word: ${word(w)})\n`,
  );
}

// One step (instruction granularity, with prefixes consumed). Pumps
// VBL once before the op so timing-sensitive code sees IRQs at the
// expected instruction boundaries.
function singleStep(machine: PC88Machine, state: DebugState): void {
  pumpVbl(machine, state.vbl);
  if (machine.cpu.halted && !machine.cpu.iff1) {
    process.stdout.write("  (HALT with IFF1=0; CPU is stuck)\n");
    return;
  }
  stepOneInstruction(machine);
  state.ops++;
}

// Run instructions until one of: breakpoint hit, step-over target
// hit, halt-no-irq, or op cap reached.
function runUntilStop(
  machine: PC88Machine,
  state: DebugState,
  reasonHint: string,
): void {
  const startOps = state.ops;
  while (state.ops - startOps < CONTINUE_MAX_OPS) {
    pumpVbl(machine, state.vbl);
    if (machine.cpu.halted && !machine.cpu.iff1) {
      process.stdout.write(`  (stopped: HALT with IFF1=0)\n`);
      return;
    }
    stepOneInstruction(machine);
    state.ops++;
    const pc = machine.cpu.regs.PC;
    if (state.stepOverTarget !== null && pc === state.stepOverTarget) {
      state.stepOverTarget = null;
      process.stdout.write(`  (stopped: step-over target ${word(pc)})\n`);
      return;
    }
    if (state.breakpoints.has(pc)) {
      process.stdout.write(`  (stopped: breakpoint @ ${word(pc)})\n`);
      return;
    }
  }
  process.stdout.write(
    `  (stopped: hit ${CONTINUE_MAX_OPS.toLocaleString()}-op ${reasonHint} cap)\n`,
  );
}

function listBreaks(state: DebugState): void {
  if (state.breakpoints.size === 0) {
    process.stdout.write("  (no breakpoints set)\n");
    return;
  }
  const sorted = [...state.breakpoints].sort((a, b) => a - b);
  process.stdout.write(`  ${sorted.map((a) => word(a)).join(" ")}\n`);
}

// REPL — reads commands, dispatches, re-prompts. Returns when the
// user types `quit` or stdin closes (e.g. Ctrl-D).
export async function runDebug(
  machine: PC88Machine,
  opts: DebugOptions = {},
): Promise<void> {
  const state: DebugState = {
    breakpoints: new Set(opts.initialBreakpoints ?? []),
    ops: 0,
    vbl: makeVblState(),
    stepOverTarget: null,
  };

  process.stdout.write(
    `pc88 debugger — paused at reset. Type "help" for commands.\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    printPromptSummary(machine);
    const raw = await rl.question("> ");
    const line = raw.trim();
    if (!line) continue;
    const [cmd, ...args] = line.split(/\s+/);
    if (cmd === undefined) continue;

    try {
      switch (cmd.toLowerCase()) {
        case "s":
        case "step":
          singleStep(machine, state);
          break;

        case "n":
        case "next": {
          // Step-over: peek the byte at PC; if it's CALL/RST, set a
          // target = PC + opLen and `continue` until we hit it. For
          // anything else, just single-step.
          const pc = machine.cpu.regs.PC;
          const op = machine.memBus.read(pc);
          const callLen = callOpLength(op);
          if (callLen !== null) {
            state.stepOverTarget = (pc + callLen) & 0xffff;
            runUntilStop(machine, state, "step-over");
          } else {
            singleStep(machine, state);
          }
          break;
        }

        case "c":
        case "cont":
        case "continue":
          runUntilStop(machine, state, "continue");
          break;

        case "b":
        case "break": {
          const a = parseAddr(args[0]);
          if (a === null) {
            process.stdout.write(`  usage: break <addr>\n`);
            break;
          }
          state.breakpoints.add(a);
          process.stdout.write(`  break @ ${word(a)}\n`);
          break;
        }

        case "bd":
        case "unbreak": {
          const a = parseAddr(args[0]);
          if (a === null) {
            process.stdout.write(`  usage: unbreak <addr>\n`);
            break;
          }
          state.breakpoints.delete(a);
          process.stdout.write(`  unbreak ${word(a)}\n`);
          break;
        }

        case "bl":
        case "breaks":
          listBreaks(state);
          break;

        case "r":
        case "regs":
          printRegs(machine);
          break;

        case "chips":
          printChips(machine);
          break;

        case "p":
        case "peek": {
          const a = parseAddr(args[0]);
          if (a === null) {
            process.stdout.write(`  usage: peek <addr> [count]\n`);
            break;
          }
          const count = args[1] ? Math.max(1, parseInt(args[1], 10)) : 1;
          doPeek(machine, a, count);
          break;
        }

        case "pw":
        case "peekw": {
          const a = parseAddr(args[0]);
          if (a === null) {
            process.stdout.write(`  usage: peekw <addr>\n`);
            break;
          }
          doPeekWord(machine, a);
          break;
        }

        case "poke": {
          const a = parseAddr(args[0]);
          const v = parseAddr(args[1]);
          if (a === null || v === null) {
            process.stdout.write(`  usage: poke <addr> <value>\n`);
            break;
          }
          machine.memBus.write(a, v & 0xff);
          process.stdout.write(`  ${word(a)} <- ${byte(v & 0xff)}\n`);
          break;
        }

        case "q":
        case "quit":
        case "exit":
          rl.close();
          return;

        case "h":
        case "?":
        case "help":
          process.stdout.write(HELP);
          break;

        default:
          process.stdout.write(
            `  unknown command "${cmd}" — type "help" for the command list\n`,
          );
      }
    } catch (e) {
      log.error(`command "${line}" failed: ${e}`);
    }
  }
}
