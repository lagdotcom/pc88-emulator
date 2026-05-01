import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { disassemble } from "../chips/z80/disasm.js";
import { mOps } from "../flavour.makers.js";
import type {
  Bytes,
  Cycles,
  FilesystemPath,
  Operations,
  u8,
  u16,
} from "../flavours.js";
import { getLogger } from "../log.js";
import { byte, word } from "../tools.js";
import {
  addLabel,
  addPortLabel,
  type DebugSymbols,
  deleteLabel,
  deletePortLabel,
  loadDebugSymbols,
  renderLabelList,
} from "./debug-symbols.js";
import {
  makeVblState,
  PC88Machine,
  pumpVbl,
  stepOneInstruction,
} from "./pc88.js";
import type { LoadedROMs } from "./pc88-memory.js";

const log = getLogger("debug");

// Cap on instructions executed by `continue` / step-over to keep a
// runaway BIOS from locking up the REPL. ~5M is comfortably more
// than a full N-BASIC banner takes.
const CONTINUE_MAX_OPS = mOps(5);

export interface DebugOptions {
  // Optional initial breakpoint addresses. CLI passes the parsed
  // `--break=ADDR` here.
  initialBreakpoints?: u16[];
  // Loaded ROM bytes — needed by the symbol layer to compute md5
  // headers for newly-created files. Optional so synthetic-ROM
  // tests can pass `undefined` and skip symbol loading entirely.
  loadedRoms?: LoadedROMs;
  // Path to a debugger-command script to run before dropping into
  // the REPL. Each non-blank, non-`#` line is dispatched as if the
  // user typed it. If the script ends with `quit`, the REPL is
  // skipped — handy for "run boot, dump state, exit" automation.
  script?: FilesystemPath;
}

// One call-stack frame, recorded each time we observe a CALL / RST
// / IRQ acceptance (= SP-2 transition) and popped on RET (= SP+2).
// Synthesised by watching SP deltas around each instruction; not
// drawn from anywhere on real silicon (Z80 has no architectural
// call stack — it's just stack-pushed return addresses).
export type CallVia = "CALL" | "RST" | "IRQ";
export interface CallFrame {
  fromPC: u16; // PC of the CALL/RST/instruction-being-interrupted
  target: u16; // where execution went (= the routine entry / IM vector)
  expectedReturn: u16; // address pushed onto the stack
  spAtCall: u16; // SP value AFTER the push
  via: CallVia;
}

// What a watchpoint matches: read, write, or both. Passed at
// register-time, not per-fire.
export type WatchMode = "r" | "w" | "rw";

// What a watchpoint does on hit. "break" stops the run loop the
// way the original watchpoints did; "log" emits a one-line trace
// (with PC + value + top call-stack frame) and keeps running. Log
// mode is the cleaner tool when init writes a port hundreds of
// times during boot but only one of those is the bug — `--script`
// captures the log to disk for later grep / diff.
export type WatchAction = "break" | "log";

interface WatchSpec {
  mode: WatchMode;
  action: WatchAction;
}

interface DebugState {
  breakpoints: Set<u16>;
  // RAM-address watchpoints: key is the address, value is the
  // direction(s) + action. memBus.read/write checks this on every
  // access while the debugger is active.
  ramWatches: Map<u16, WatchSpec>;
  // I/O port watchpoints: key is the port low byte (the debugger
  // inspects `port & 0xff` to match how chips dispatch).
  portWatches: Map<u8, WatchSpec>;
  // Synthesised call stack. Pushed on CALL/RST/IRQ, popped on RET.
  // Bounded depth to keep runaway recursion from eating memory in
  // pathological boot loops; oldest frame is dropped when the cap
  // is hit so the deepest N frames stay visible.
  callStack: CallFrame[];
  // Set by trackedStep when a *break-mode* watchpoint fires. The
  // run loop checks this between instructions and stops when set.
  stopReason: string | null;
  ops: Operations;
  vbl: ReturnType<typeof makeVblState>;
  // Set during step-over: target PC where execution should pause if
  // it returns from the called subroutine. null means "no pending
  // step-over".
  stepOverTarget: u16 | null;
  // Ring buffer of recently-executed PCs — answers "how did we get
  // here?" when a watch / break hit lands in a function whose entry
  // path isn't visible from `stack` (because no CALL was involved,
  // e.g. a JR / JP / fall-through). Updated each instruction by
  // trackedStep; auto-printed on watch / break hits, manually
  // dumped via the `trace` command.
  pcTrace: Uint16Array;
  pcTraceWrite: number; // next slot to write
  pcTraceFilled: number; // 0..PC_TRACE_SIZE
}

const MAX_CALL_STACK_DEPTH = 256;
const PC_TRACE_SIZE = 64;
// How many trace lines auto-printed on a watch / break stop. Full
// 64 is too noisy when single-stepping near the stop; 8 is the
// sweet spot for "what got us here".
const AUTO_TRACE_LINES = 8;

const HELP = `\
Debugger commands (anything in <> takes a hex address; "0x" optional):

Stepping / running:
  s, step                 single-step one instruction
  n, next                 step over (CALL/RST → run until after the call)
  c, continue [cycles]    run until breakpoint / watch / halt / op cap;
                          with a numeric arg, also stop after N CPU cycles
  q, quit, exit           leave the debugger / end script

Code breakpoints:
  b, break <addr>         add a code breakpoint at <addr>
  bd, unbreak <addr>      remove a code breakpoint
  bl, breaks              list code breakpoints

RAM watchpoints (stop on access):
  bw <addr> [r|w|rw] [log]  watch a RAM address; default rw, break.
                            Add "log" to print a one-line trace and
                            keep running instead of stopping.
  unbw <addr>             remove a RAM watchpoint
  bwl                     list RAM watchpoints

Port watchpoints (stop on IN/OUT):
  bp <port> [r|w|rw] [log]  watch an I/O port; default rw, break.
                            "log" runs through, "break" stops.
  unbp <port>             remove a port watchpoint
  bpl                     list port watchpoints

Inspection:
  r, regs                 show CPU registers
  chips                   show CRTC / DMAC / IRQ / sysctrl / DIP state
  screen                  render the CRTC+DMAC visible region
  stack                   show the synthesised CALL/RST/IRQ call stack
  trace [count]           dump the last [count] PCs (default 16,
                          max 64); auto-printed (last 8) on watch /
                          break stops
  dis [count]             disassemble the next [count] instructions
                          (default 8) starting at PC
  p, peek <addr> [count]  read N bytes (default 1) at <addr>
  pw, peekw <addr>        read 16-bit little-endian word at <addr>
  poke <addr> <value>     write a byte

Symbols:
  label <addr> <name>     add or rename a ROM/RAM symbol
  unlabel <addr-or-name>  remove a symbol
  portlabel <num> <name>  add or rename a port symbol
  unportlabel <n-or-name> remove a port symbol
  labels                  list every loaded symbol grouped by scope

Misc:
  h, ?, help              this help
  # any line              comment (in scripts; ignored in REPL)

Watchpoint examples:
  bw 0xed72 w             stop the next time anything writes to 0xed72
  bw 0xed72 r             stop on read
  bw 0xed72               stop on either (= "rw")
  bw 0xed72 w log         log every write to 0xed72 without stopping
  bp 0x71 rw              stop on any IN/OUT against port 0x71
  bp 0x71 w log           log writes to port 0x71 (boot-init noise)
`;

// Parse a cycle-count argument (no u16 wrap, can be larger than
// 0xFFFF). Accepts the same syntaxes as parseAddr but returns the
// full integer value rather than masking to 16 bits.
function parseCycleArg(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s.startsWith("0x")) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (/^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) {
    const n = parseInt(s, 16);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Hex parser that accepts "0xff", "ff", or decimal "255".
function parseAddr(raw: string | undefined): u16 | null {
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
function callOpLength(opcode: u8): Bytes | null {
  // Unconditional CALL: 0xCD, 3 bytes
  if (opcode === 0xcd) return 3;
  // Conditional CALL Cc: 0xC4 / CC / D4 / DC / E4 / EC / F4 / FC, 3 bytes
  if ((opcode & 0xc7) === 0xc4) return 3;
  // RST p: 0xC7 / CF / D7 / DF / E7 / EF / F7 / FF, 1 byte
  if ((opcode & 0xc7) === 0xc7) return 1;
  return null;
}

function classifyCallOp(opcode: u8): CallVia | null {
  if (opcode === 0xcd) return "CALL";
  if ((opcode & 0xc7) === 0xc4) return "CALL"; // CALL cc, nn
  if ((opcode & 0xc7) === 0xc7) return "RST";
  return null;
}

function isRetOp(opcode: u8): boolean {
  // Unconditional RET: 0xC9, 1 byte. Conditional RET Cc:
  // 0xC0 / 0xC8 / 0xD0 / 0xD8 / 0xE0 / 0xE8 / 0xF0 / 0xF8.
  // RETI / RETN are ED-prefix (we don't see the prefix byte at PC
  // when this function runs because stepOneInstruction has consumed
  // the prefix already).
  if (opcode === 0xc9) return true;
  if ((opcode & 0xc7) === 0xc0) return true;
  return false;
}

function pushFrame(state: DebugState, frame: CallFrame): void {
  if (state.callStack.length >= MAX_CALL_STACK_DEPTH) {
    // Drop oldest so the newest frames stay visible. Boot loops
    // would otherwise eat memory through pathological recursion.
    state.callStack.shift();
  }
  state.callStack.push(frame);
}

// One instruction with bookkeeping: pumps VBL, runs the op, then
// observes SP delta + PC change to maintain the call-stack model.
// Watchpoints are checked inside memBus.read / write / ioBus.tracer
// hooks installed by installWatchHooks(); they set state.stopReason
// which the run loop drains between instructions.
function trackedStep(machine: PC88Machine, state: DebugState): void {
  pumpVbl(machine, state.vbl);
  if (machine.cpu.halted && !machine.cpu.iff1) return;

  const prePC = machine.cpu.regs.PC;
  const preSP = machine.cpu.regs.SP;
  const preOp = machine.memBus.read(prePC);
  const preIff = machine.cpu.iff1;

  // Push the about-to-execute PC into the ring buffer. This means
  // the trace contains *executed* PCs (the last entry is the most
  // recent instruction completed by the time we're back here);
  // pairing well with `regs.PC` showing the *next* PC at stop.
  state.pcTrace[state.pcTraceWrite] = prePC;
  state.pcTraceWrite = (state.pcTraceWrite + 1) % PC_TRACE_SIZE;
  if (state.pcTraceFilled < PC_TRACE_SIZE) state.pcTraceFilled++;

  stepOneInstruction(machine);
  state.ops++;

  const postPC = machine.cpu.regs.PC;
  const postSP = machine.cpu.regs.SP;

  // SP-2 + PC moved off-instruction → either CALL/RST (PC at op
  // determined the target) or IRQ acceptance (CPU pushed PC and
  // jumped to a vector). Discriminate by whether the pre-op opcode
  // was a CALL/RST: if yes, that's the explicit branch; if no but
  // SP went down by 2, the CPU accepted an IRQ.
  if (postSP === ((preSP - 2) & 0xffff)) {
    const via = classifyCallOp(preOp);
    if (via !== null) {
      const opLen = via === "RST" ? 1 : 3;
      pushFrame(state, {
        fromPC: prePC,
        target: postPC,
        expectedReturn: (prePC + opLen) & 0xffff,
        spAtCall: postSP,
        via,
      });
    } else if (preIff && !machine.cpu.iff1) {
      // IFF1 cleared → IRQ accepted. The CPU pushed prePC (the
      // about-to-execute insn) and jumped to its vector.
      pushFrame(state, {
        fromPC: prePC,
        target: postPC,
        expectedReturn: prePC,
        spAtCall: postSP,
        via: "IRQ",
      });
    }
  } else if (postSP === ((preSP + 2) & 0xffff) && isRetOp(preOp)) {
    // RET-like — drop the top frame if our model has one. Pop is
    // best-effort: BASIC code can use PUSH/RET as gosub or unwind
    // the stack out from under us, in which case we'll bottom out
    // at depth 0 and stay there until the next CALL.
    if (state.callStack.length > 0) state.callStack.pop();
  }
}

interface WatchHooks {
  uninstall: () => void;
}

// Wrap memBus.read/write and ioBus.tracer so RAM and port watches
// fire when the CPU touches a watched address. break-mode watches
// set state.stopReason — the run loop drains it between
// instructions and halts cleanly. log-mode watches emit a one-line
// trace (with PC, value, top-of-call-stack label if known) and
// keep going. Returns an `uninstall` callback that restores the
// originals (used at REPL exit).
function installWatchHooks(
  machine: PC88Machine,
  state: DebugState,
  syms: DebugSymbols | null,
): WatchHooks {
  const origRead = machine.memBus.read.bind(machine.memBus);
  const origWrite = machine.memBus.write.bind(machine.memBus);
  const origTracer = machine.ioBus.tracer;

  // Format a log line with a PC label resolved through syms if
  // available. We use the live PC, not the call-stack target,
  // because the line's most useful question is "which instruction
  // touched this byte?" — `stack` already exposes the calling
  // frame for cross-reference.
  const logHit = (kind: string, body: string): void => {
    const pc = machine.cpu.regs.PC;
    const pcLabel = syms?.resolver(pc);
    const tag = pcLabel ? `${word(pc)} <${pcLabel}>` : word(pc);
    process.stdout.write(`[watch] PC=${tag} ${kind} ${body}\n`);
  };

  const matches = (mode: WatchMode, kind: "r" | "w"): boolean =>
    mode === "rw" || mode === kind;

  machine.memBus.read = (addr: u16): u8 => {
    const v = origRead(addr);
    const w = state.ramWatches.get(addr & 0xffff);
    if (w && matches(w.mode, "r")) {
      const body = `RAM read @ ${word(addr)} = ${byte(v)}`;
      if (w.action === "log") logHit("r", body);
      else state.stopReason = body;
    }
    return v;
  };
  machine.memBus.write = (addr: u16, value: u8): void => {
    const w = state.ramWatches.get(addr & 0xffff);
    if (w && matches(w.mode, "w")) {
      const body = `RAM write @ ${word(addr)} <- ${byte(value)}`;
      if (w.action === "log") logHit("w", body);
      else state.stopReason = body;
    }
    origWrite(addr, value);
  };
  machine.ioBus.tracer = (kind, port, value) => {
    if (origTracer) origTracer(kind, port, value);
    const w = state.portWatches.get(port & 0xff);
    if (w && matches(w.mode, kind)) {
      const dir = kind === "r" ? "IN " : "OUT";
      const body = `port ${dir} ${byte(port & 0xff)} = ${byte(value)}`;
      if (w.action === "log") logHit(kind, body);
      else state.stopReason = body;
    }
  };

  return {
    uninstall: () => {
      machine.memBus.read = origRead;
      machine.memBus.write = origWrite;
      machine.ioBus.tracer = origTracer;
    },
  };
}

// Parse the trailing tokens of a `bw` / `bp` line. Order-
// independent: any combination of a mode (`r`/`w`/`rw`) and an
// action (`break`/`log`) is accepted; missing tokens default to
// `rw` + `break`. Returns null if any token doesn't fit.
function parseWatchSpec(args: string[]): WatchSpec | null {
  let mode: WatchMode = "rw";
  let action: WatchAction = "break";
  for (const raw of args) {
    const s = raw.trim().toLowerCase();
    if (s === "r" || s === "w" || s === "rw") mode = s;
    else if (s === "break" || s === "log") action = s;
    else return null;
  }
  return { mode, action };
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
      `  crtc         : ${snap.crtc.charsPerRow}-byte run × ${snap.crtc.rowsPerScreen} rows ` +
      `(${snap.sysctrl.cols80 ? "80-col 1-byte cells" : "40-col 2-byte cells"}, ` +
      `dma=${snap.crtc.dmaCharMode ? "char" : "burst"}, ` +
      `gfx=${snap.crtc.gfxMode.toString(2).padStart(3, "0")}, ` +
      `attr-pairs/row=${snap.crtc.attrPairsPerRow}, ` +
      `display=${snap.crtc.displayOn ? "on" : "off"}, ` +
      `status=${byte(snap.crtc.status)})\n` +
      `  dmac ch2     : src=${word(dmac.channelAddress(2))} count=${dmac.channelByteCount(2)}\n` +
      `  irq          : mask=${byte(snap.irq.mask)} (programmed=${snap.irq.programmed}) priority=${byte(snap.irq.priority)}\n` +
      `  beeper       : ${snap.beeper.toggles} toggles\n` +
      `  misc latches : 0xE7=${snap.misc.lastE7 ?? "-"} 0xF8=${snap.misc.lastF8 ?? "-"}\n`,
  );
}

// One-line summary printed before each prompt: PC, the raw bytes
// the next instruction occupies, and the disassembled mnemonic. The
// disassembler reads through `machine.memBus` so bank-switched
// pages are interpreted as the CPU sees them.
function printPromptSummary(
  machine: PC88Machine,
  syms: DebugSymbols | null,
): void {
  const pc = machine.cpu.regs.PC;
  const opts = syms
    ? { resolveLabel: syms.resolver, resolvePort: syms.portResolver }
    : {};
  const d = disassemble((a) => machine.memBus.read(a), pc, opts);
  const bytesStr = d.bytes
    .map((b) => byte(b))
    .join(" ")
    .padEnd(11);
  // If this PC has its own label, print it as a header line so
  // function entry points stand out — same convention `yarn dis`
  // uses. Exact match only — fuzzy `name+N` matches don't get
  // their own header, otherwise every mid-function step would be
  // prefixed with a noisy `name+2:` / `name+4:` / etc. line.
  const labelHere = syms?.exactResolver(pc);
  if (labelHere) process.stdout.write(`${labelHere}:\n`);
  process.stdout.write(`  @ ${word(pc)}: ${bytesStr}  ${d.mnemonic}\n`);
}

// Multi-line disassembly listing for the `dis` command. Walks
// forward using each instruction's reported length so the next
// line shows the actual following instruction, not a fixed offset.
function printDisassembly(
  machine: PC88Machine,
  syms: DebugSymbols | null,
  count: Bytes,
): void {
  let pc = machine.cpu.regs.PC;
  const opts = syms
    ? { resolveLabel: syms.resolver, resolvePort: syms.portResolver }
    : {};
  for (let i = 0; i < count; i++) {
    const labelHere = syms?.exactResolver(pc);
    if (labelHere) process.stdout.write(`${labelHere}:\n`);
    const d = disassemble((a) => machine.memBus.read(a), pc, opts);
    const bytesStr = d.bytes
      .map((b) => byte(b))
      .join(" ")
      .padEnd(11);
    process.stdout.write(`  ${word(pc)}: ${bytesStr}  ${d.mnemonic}\n`);
    pc = (pc + d.length) & 0xffff;
  }
}

function doPeek(machine: PC88Machine, addr: u16, count: Bytes): void {
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

function doPeekWord(machine: PC88Machine, addr: u16): void {
  const lo = machine.memBus.read(addr & 0xffff);
  const hi = machine.memBus.read((addr + 1) & 0xffff);
  const w = ((hi << 8) | lo) & 0xffff;
  process.stdout.write(
    `  ${word(addr)}: ${byte(lo)} ${byte(hi)}  (LE word: ${word(w)})\n`,
  );
}

// One step (instruction granularity, with prefixes consumed). Pumps
// VBL once before the op so timing-sensitive code sees IRQs at the
// expected instruction boundaries. Watchpoint hits during the
// instruction are reported but don't stop a single step (the user
// asked for one instruction, and a watch fired during it — let the
// next `step` / `continue` see the watch state).
function singleStep(machine: PC88Machine, state: DebugState): void {
  if (machine.cpu.halted && !machine.cpu.iff1) {
    process.stdout.write("  (HALT with IFF1=0; CPU is stuck)\n");
    return;
  }
  trackedStep(machine, state);
  if (state.stopReason) {
    process.stdout.write(`  ${state.stopReason}\n`);
    state.stopReason = null;
  }
}

// Run instructions until one of: breakpoint hit, watchpoint hit,
// step-over target hit, halt-no-irq, op cap reached, or (when
// `maxCycles` is set) the cycle budget exhausted. On a watch /
// breakpoint stop the last AUTO_TRACE_LINES PCs are printed first
// — typically what the user wanted next anyway, and avoids a
// second prompt to ask "how did we get here?".
function runUntilStop(
  machine: PC88Machine,
  state: DebugState,
  syms: DebugSymbols | null,
  reasonHint: string,
  maxCycles?: Cycles,
): void {
  const startOps = state.ops;
  const startCycles = machine.cpu.cycles;
  const cycleBudget = maxCycles !== undefined ? maxCycles : Infinity;
  while (state.ops - startOps < CONTINUE_MAX_OPS) {
    if (machine.cpu.cycles - startCycles >= cycleBudget) {
      process.stdout.write(
        `  (stopped: ${(machine.cpu.cycles - startCycles).toLocaleString()} cycles run)\n`,
      );
      return;
    }
    if (machine.cpu.halted && !machine.cpu.iff1) {
      process.stdout.write(`  (stopped: HALT with IFF1=0)\n`);
      return;
    }
    trackedStep(machine, state);
    const pc = machine.cpu.regs.PC;
    if (state.stopReason) {
      printPcTrace(machine, state, syms, AUTO_TRACE_LINES);
      process.stdout.write(`  (stopped: ${state.stopReason})\n`);
      state.stopReason = null;
      return;
    }
    if (state.stepOverTarget !== null && pc === state.stepOverTarget) {
      state.stepOverTarget = null;
      process.stdout.write(`  (stopped: step-over target ${word(pc)})\n`);
      return;
    }
    if (state.breakpoints.has(pc)) {
      printPcTrace(machine, state, syms, AUTO_TRACE_LINES);
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

function listRamWatches(state: DebugState): void {
  if (state.ramWatches.size === 0) {
    process.stdout.write("  (no RAM watchpoints)\n");
    return;
  }
  const sorted = [...state.ramWatches.entries()].sort((a, b) => a[0] - b[0]);
  for (const [addr, w] of sorted) {
    process.stdout.write(`  ${word(addr)} ${w.mode.padEnd(2)} ${w.action}\n`);
  }
}

function listPortWatches(state: DebugState): void {
  if (state.portWatches.size === 0) {
    process.stdout.write("  (no port watchpoints)\n");
    return;
  }
  const sorted = [...state.portWatches.entries()].sort((a, b) => a[0] - b[0]);
  for (const [port, w] of sorted) {
    process.stdout.write(`  ${byte(port)} ${w.mode.padEnd(2)} ${w.action}\n`);
  }
}

// Read the last `n` PC trace entries oldest-first. Uses the
// circular layout populated by trackedStep: write index is the
// next slot to fill, so the oldest of `count` entries lives at
// `(write - count) mod size` and we walk forward from there.
function readPcTrace(state: DebugState, n: number): u16[] {
  const count = Math.min(n, state.pcTraceFilled);
  if (count === 0) return [];
  const start = (state.pcTraceWrite - count + PC_TRACE_SIZE) % PC_TRACE_SIZE;
  const out: u16[] = [];
  for (let i = 0; i < count; i++) {
    out.push(state.pcTrace[(start + i) % PC_TRACE_SIZE]!);
  }
  return out;
}

// Print the most recent `n` PCs leading up to the current
// instruction, oldest-first, with disassembly + label resolution.
// Disassembly is rendered through the LIVE memory map — bank
// switches that happened between the trace entry running and now
// will lie about the instruction bytes. Acceptable for diagnosis;
// flagged in the header so users notice if they hit a swap.
function printPcTrace(
  machine: PC88Machine,
  state: DebugState,
  syms: DebugSymbols | null,
  n: number,
): void {
  const trace = readPcTrace(state, n);
  if (trace.length === 0) {
    process.stdout.write(`  (PC trace empty — nothing executed since reset)\n`);
    return;
  }
  process.stdout.write(
    `  PC trace (last ${trace.length} of ${state.pcTraceFilled} captured, oldest first):\n`,
  );
  const opts = syms
    ? { resolveLabel: syms.resolver, resolvePort: syms.portResolver }
    : {};
  let lastLabel: string | undefined;
  for (const pc of trace) {
    const exact = syms?.exactResolver(pc);
    if (exact && exact !== lastLabel) {
      process.stdout.write(`  ${exact}:\n`);
      lastLabel = exact;
    }
    const d = disassemble((a) => machine.memBus.read(a), pc, opts);
    process.stdout.write(`    ${word(pc)}  ${d.mnemonic}\n`);
  }
}

// Render the synthesised call stack with the most-recent frame at
// the top (the "current" frame). Each line shows the via-kind
// (CALL / RST / IRQ), the routine entry, the call site, the return
// address that's actually pushed on the Z80 stack, and the SP value
// at push time — useful for matching frames against a hardware
// stack-dump in the same window.
function printCallStack(state: DebugState, syms: DebugSymbols | null): void {
  if (state.callStack.length === 0) {
    process.stdout.write("  (call stack empty)\n");
    return;
  }
  for (let i = state.callStack.length - 1; i >= 0; i--) {
    const f = state.callStack[i]!;
    const tLabel = syms?.exactResolver(f.target);
    const fLabel = syms?.exactResolver(f.fromPC);
    const tStr = tLabel ? `${word(f.target)} <${tLabel}>` : word(f.target);
    const fStr = fLabel ? `${word(f.fromPC)} <${fLabel}>` : word(f.fromPC);
    const depth = (state.callStack.length - 1 - i).toString().padStart(2);
    process.stdout.write(
      `  #${depth} ${f.via.padEnd(4)} ${tStr} <- ${fStr} ` +
        `(ret=${word(f.expectedReturn)} sp=${word(f.spAtCall)})\n`,
    );
  }
}

interface DispatchCtx {
  machine: PC88Machine;
  state: DebugState;
  syms: DebugSymbols | null;
  opts: DebugOptions;
}

// Single command dispatcher. Shared between the interactive REPL and
// the script-file runner: each line goes through here so the two
// paths can never drift. Returns `{ quit: true }` when the command
// asks to leave the debugger; the caller decides what that means
// (REPL: close readline and return; script: stop reading further
// lines).
async function dispatch(
  raw: string,
  ctx: DispatchCtx,
): Promise<{ quit: boolean }> {
  const line = raw.trim();
  if (!line) return { quit: false };
  // `#` is a script-comment marker. Treat the same way in the REPL
  // (a no-op) so script lines pasted interactively still work.
  if (line.startsWith("#")) return { quit: false };
  const [cmd, ...args] = line.split(/\s+/);
  if (cmd === undefined) return { quit: false };

  const { machine, state, syms, opts } = ctx;

  try {
    switch (cmd.toLowerCase()) {
      case "s":
      case "step":
        singleStep(machine, state);
        return { quit: false };

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
          runUntilStop(machine, state, syms, "step-over");
        } else {
          singleStep(machine, state);
        }
        return { quit: false };
      }

      case "c":
      case "cont":
      case "continue": {
        // `continue` with no arg: existing behaviour (run until
        // breakpoint / watch / halt / op cap). `continue N` adds
        // an N-cycle stop condition on top — useful for "step
        // forward by ~one frame's worth" without setting a PC
        // breakpoint. Hex (0x... or trailing hex chars) and
        // decimal both work.
        let cycleBudget: Cycles | undefined;
        if (args[0] !== undefined) {
          const n = parseCycleArg(args[0]);
          if (n === null) {
            process.stdout.write(`  usage: continue [cycles]\n`);
            return { quit: false };
          }
          cycleBudget = n;
        }
        runUntilStop(machine, state, syms, "continue", cycleBudget);
        return { quit: false };
      }

      case "b":
      case "break": {
        const a = parseAddr(args[0]);
        if (a === null) {
          process.stdout.write(`  usage: break <addr>\n`);
          return { quit: false };
        }
        state.breakpoints.add(a);
        process.stdout.write(`  break @ ${word(a)}\n`);
        return { quit: false };
      }

      case "bd":
      case "unbreak": {
        const a = parseAddr(args[0]);
        if (a === null) {
          process.stdout.write(`  usage: unbreak <addr>\n`);
          return { quit: false };
        }
        state.breakpoints.delete(a);
        process.stdout.write(`  unbreak ${word(a)}\n`);
        return { quit: false };
      }

      case "bl":
      case "breaks":
        listBreaks(state);
        return { quit: false };

      case "bw": {
        const a = parseAddr(args[0]);
        if (a === null) {
          process.stdout.write(`  usage: bw <addr> [r|w|rw] [break|log]\n`);
          return { quit: false };
        }
        const spec = parseWatchSpec(args.slice(1));
        if (spec === null) {
          process.stdout.write(
            `  bad watch spec (want r|w|rw + optional break|log)\n`,
          );
          return { quit: false };
        }
        state.ramWatches.set(a, spec);
        process.stdout.write(
          `  watch RAM ${word(a)} ${spec.mode} ${spec.action}\n`,
        );
        return { quit: false };
      }

      case "unbw": {
        const a = parseAddr(args[0]);
        if (a === null) {
          process.stdout.write(`  usage: unbw <addr>\n`);
          return { quit: false };
        }
        if (state.ramWatches.delete(a)) {
          process.stdout.write(`  unwatched RAM ${word(a)}\n`);
        } else {
          process.stdout.write(`  no RAM watch at ${word(a)}\n`);
        }
        return { quit: false };
      }

      case "bwl":
        listRamWatches(state);
        return { quit: false };

      case "bp": {
        const p = parseAddr(args[0]);
        if (p === null) {
          process.stdout.write(`  usage: bp <port> [r|w|rw] [break|log]\n`);
          return { quit: false };
        }
        const spec = parseWatchSpec(args.slice(1));
        if (spec === null) {
          process.stdout.write(
            `  bad watch spec (want r|w|rw + optional break|log)\n`,
          );
          return { quit: false };
        }
        const port = p & 0xff;
        state.portWatches.set(port, spec);
        process.stdout.write(
          `  watch port ${byte(port)} ${spec.mode} ${spec.action}\n`,
        );
        return { quit: false };
      }

      case "unbp": {
        const p = parseAddr(args[0]);
        if (p === null) {
          process.stdout.write(`  usage: unbp <port>\n`);
          return { quit: false };
        }
        const port = p & 0xff;
        if (state.portWatches.delete(port)) {
          process.stdout.write(`  unwatched port ${byte(port)}\n`);
        } else {
          process.stdout.write(`  no port watch at ${byte(port)}\n`);
        }
        return { quit: false };
      }

      case "bpl":
        listPortWatches(state);
        return { quit: false };

      case "r":
      case "regs":
        printRegs(machine);
        return { quit: false };

      case "chips":
        printChips(machine);
        return { quit: false };

      case "screen":
        // Same surface as the headless runner's "--- Visible screen
        // ---" block. Renders the CRTC+DMAC region; falls back to a
        // placeholder string before SET MODE has run so the user
        // doesn't have to remember which init step gates it.
        process.stdout.write(machine.display.toASCIIDump() + "\n");
        return { quit: false };

      case "stack":
        printCallStack(state, syms);
        return { quit: false };

      case "trace": {
        // Default 16 — long enough to cover a small function entry,
        // short enough to scan at a glance. The ring is sized
        // PC_TRACE_SIZE; over-large requests clamp.
        const requested = args[0] ? parseInt(args[0], 10) : 16;
        const count =
          Number.isFinite(requested) && requested > 0
            ? Math.min(requested, PC_TRACE_SIZE)
            : 16;
        printPcTrace(machine, state, syms, count);
        return { quit: false };
      }

      case "dis":
      case "l":
      case "list": {
        // Default to 8 instructions ahead — enough to spot a CALL
        // / loop / branch without flooding the screen. Counts
        // larger than 256 are clamped (debugger should stay
        // responsive even if the user fat-fingers a big number).
        const count = Math.min(
          256,
          Math.max(1, args[0] ? parseInt(args[0], 10) || 8 : 8),
        );
        printDisassembly(machine, syms, count);
        return { quit: false };
      }

      case "label": {
        // `label <addr> <name> [comment...]`. The trailing args
        // are joined into a single comment so users can write
        // free-form descriptions without needing to quote.
        if (!syms || !opts.loadedRoms) {
          process.stdout.write(
            `  symbols not loaded (need ROM bytes to compute md5 headers)\n`,
          );
          return { quit: false };
        }
        const a = parseAddr(args[0]);
        const name = args[1];
        if (a === null || !name) {
          process.stdout.write(`  usage: label <addr> <name> [comment...]\n`);
          return { quit: false };
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          process.stdout.write(
            `  name must start with a letter/_ and use [A-Za-z0-9_] only\n`,
          );
          return { quit: false };
        }
        const comment = args.slice(2).join(" ").trim() || undefined;
        try {
          const r = await addLabel(
            machine,
            opts.loadedRoms,
            syms,
            a,
            name,
            comment,
          );
          process.stdout.write(`  label ${word(a)} = ${name} → ${r.path}\n`);
        } catch (e) {
          process.stdout.write(`  label failed: ${(e as Error).message}\n`);
        }
        return { quit: false };
      }

      case "unlabel": {
        if (!syms) {
          process.stdout.write(`  symbols not loaded\n`);
          return { quit: false };
        }
        const arg = args[0];
        if (!arg) {
          process.stdout.write(`  usage: unlabel <addr-or-name>\n`);
          return { quit: false };
        }
        const target = /^[A-Za-z_]/.test(arg) ? arg : (parseAddr(arg) ?? null);
        if (target === null) {
          process.stdout.write(`  bad address or name: ${arg}\n`);
          return { quit: false };
        }
        const r = await deleteLabel(machine, syms, target);
        if (r) {
          process.stdout.write(`  unlabelled in ${r.path}\n`);
        } else {
          process.stdout.write(`  no symbol matches ${arg}\n`);
        }
        return { quit: false };
      }

      case "portlabel": {
        // `portlabel <num> <name> [comment...]`. Lives in the
        // variant-wide port file; appears in disassembly for
        // `IN A,(n)` / `OUT (n),A` operands.
        if (!syms) {
          process.stdout.write(`  symbols not loaded\n`);
          return { quit: false };
        }
        const p = parseAddr(args[0]);
        const name = args[1];
        if (p === null || !name) {
          process.stdout.write(
            `  usage: portlabel <num> <name> [comment...]\n`,
          );
          return { quit: false };
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          process.stdout.write(
            `  name must start with a letter/_ and use [A-Za-z0-9_] only\n`,
          );
          return { quit: false };
        }
        const comment = args.slice(2).join(" ").trim() || undefined;
        const r = await addPortLabel(machine, syms, p, name, comment);
        process.stdout.write(`  port ${byte(p)} = ${name} → ${r.path}\n`);
        return { quit: false };
      }

      case "unportlabel": {
        if (!syms) {
          process.stdout.write(`  symbols not loaded\n`);
          return { quit: false };
        }
        const arg = args[0];
        if (!arg) {
          process.stdout.write(`  usage: unportlabel <num-or-name>\n`);
          return { quit: false };
        }
        const target = /^[A-Za-z_]/.test(arg) ? arg : (parseAddr(arg) ?? null);
        if (target === null) {
          process.stdout.write(`  bad port or name: ${arg}\n`);
          return { quit: false };
        }
        const r = await deletePortLabel(syms, target);
        if (r) process.stdout.write(`  unlabelled in ${r.path}\n`);
        else process.stdout.write(`  no port symbol matches ${arg}\n`);
        return { quit: false };
      }

      case "labels":
        if (!syms) {
          process.stdout.write(`  symbols not loaded\n`);
          return { quit: false };
        }
        process.stdout.write(renderLabelList(syms) + "\n");
        return { quit: false };

      case "p":
      case "peek": {
        const a = parseAddr(args[0]);
        if (a === null) {
          process.stdout.write(`  usage: peek <addr> [count]\n`);
          return { quit: false };
        }
        const count = args[1] ? Math.max(1, parseInt(args[1], 10)) : 1;
        doPeek(machine, a, count);
        return { quit: false };
      }

      case "pw":
      case "peekw": {
        const a = parseAddr(args[0]);
        if (a === null) {
          process.stdout.write(`  usage: peekw <addr>\n`);
          return { quit: false };
        }
        doPeekWord(machine, a);
        return { quit: false };
      }

      case "poke": {
        const a = parseAddr(args[0]);
        const v = parseAddr(args[1]);
        if (a === null || v === null) {
          process.stdout.write(`  usage: poke <addr> <value>\n`);
          return { quit: false };
        }
        machine.memBus.write(a, v & 0xff);
        process.stdout.write(`  ${word(a)} <- ${byte(v & 0xff)}\n`);
        return { quit: false };
      }

      case "q":
      case "quit":
      case "exit":
        return { quit: true };

      case "h":
      case "?":
      case "help":
        process.stdout.write(HELP);
        return { quit: false };

      default:
        process.stdout.write(
          `  unknown command "${cmd}" — type "help" for the command list\n`,
        );
        return { quit: false };
    }
  } catch (e) {
    log.error(`command "${line}" failed: ${e}`);
    return { quit: false };
  }
}

// Replay a debugger script through the same dispatcher the REPL
// uses. Blank lines are skipped silently. Each non-blank line is
// echoed with a `script>` prefix so the captured output can be
// matched against the input later. If the script issues `quit`
// the runner stops reading and signals the caller to skip the REPL.
async function runScript(
  path: FilesystemPath,
  ctx: DispatchCtx,
): Promise<{ quit: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    process.stdout.write(
      `  failed to read script ${path}: ${(e as Error).message}\n`,
    );
    return { quit: false };
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    process.stdout.write(`script> ${trimmed}\n`);
    const result = await dispatch(rawLine, ctx);
    if (result.quit) return { quit: true };
  }
  return { quit: false };
}

// REPL — reads commands, dispatches, re-prompts. Returns when the
// user types `quit` or stdin closes (e.g. Ctrl-D). When opts.script
// is set, that script runs first; if it ends with `quit`, the REPL
// is skipped — handy for "boot, dump state, exit" automation.
export async function runDebug(
  machine: PC88Machine,
  opts: DebugOptions = {},
): Promise<void> {
  const state: DebugState = {
    breakpoints: new Set(opts.initialBreakpoints ?? []),
    ramWatches: new Map(),
    portWatches: new Map(),
    callStack: [],
    stopReason: null,
    ops: 0,
    vbl: makeVblState(),
    stepOverTarget: null,
    pcTrace: new Uint16Array(PC_TRACE_SIZE),
    pcTraceWrite: 0,
    pcTraceFilled: 0,
  };

  // Symbol files are optional — synthetic-ROM tests don't pass
  // `loadedRoms`. When present, the resolver feeds disassembly and
  // the `label` / `unlabel` / `labels` commands; when absent,
  // those commands print a friendly diagnostic instead of crashing.
  const syms: DebugSymbols | null = opts.loadedRoms
    ? await loadDebugSymbols(machine, opts.loadedRoms)
    : null;
  if (syms) {
    let count = 0;
    for (const e of syms.byRomId.values()) count += e.file.byAddr.size;
    process.stdout.write(
      `pc88 debugger — paused at reset. ${count} labels loaded across ${syms.byRomId.size} ROMs. ` +
        `Type "help" for commands.\n`,
    );
  } else {
    process.stdout.write(
      `pc88 debugger — paused at reset. Type "help" for commands.\n`,
    );
  }

  const hooks = installWatchHooks(machine, state, syms);
  try {
    const ctx: DispatchCtx = { machine, state, syms, opts };

    if (opts.script) {
      const result = await runScript(opts.script, ctx);
      if (result.quit) return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    while (true) {
      printPromptSummary(machine, syms);
      const raw = await rl.question("> ");
      const result = await dispatch(raw, ctx);
      if (result.quit) {
        rl.close();
        return;
      }
    }
  } finally {
    hooks.uninstall();
  }
}
