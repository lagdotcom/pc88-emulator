import { disassemble } from "../chips/z80/disasm.js";
import type { ROMID, u16 } from "../flavours.js";
import { getLogger } from "../log.js";
import {
  callOpLength,
  type DebugState,
  dispatch,
  installWatchHooks,
  makeDebugState,
  setDebugWriter,
  trackedStep,
} from "../machines/debug.js";
import {
  type DebugSymbols,
  loadDebugSymbols,
} from "../machines/debug-symbols.js";
import { PC88Machine, VBL_HZ } from "../machines/pc88.js";
import { loadRomsFromMap } from "../machines/rom-loader-browser.js";
import { md5 } from "./md5.js";
import type {
  CPUSnapshot,
  DebugSnapshot,
  DisasmLine,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";

const log = getLogger("web/worker");

// Run loop: per wall-clock tick advance the emulator by one VBL
// period's worth of CPU cycles, then post a frame update. 60 Hz wall
// pacing comes from setTimeout — rAF isn't available in worker
// contexts, and the UI thread already throttles its repaints to a
// real rAF when the tick lands.
const Z80_HZ = 4_000_000;
const FRAME_CYCLES = Math.round(Z80_HZ / VBL_HZ);
const FRAME_INTERVAL_MS = Math.round(1000 / VBL_HZ);

interface State {
  machine: PC88Machine;
  running: boolean;
  loopHandle: ReturnType<typeof setTimeout> | null;
  debug: DebugState;
  // Lazily resolved by the OPFS-backed loadDebugSymbols. Null until
  // the async load completes; dispatch's label commands degrade
  // gracefully ("symbols not loaded") in the brief window between
  // boot and the syms promise resolving.
  syms: DebugSymbols | null;
  // Held alongside `syms` because the `label` command needs the
  // ROM bytes to compute md5s for first-mutation file seeding.
  loadedRoms: LoadedROMsLike | null;
}

// Minimal alias of LoadedROMs — pulled in via debug.ts opts so the
// label command can self-seed an md5 header on first write.
type LoadedROMsLike = Parameters<typeof loadDebugSymbols>[1];

let state: State | null = null;

const workerSelf = self as unknown as Worker;

function post(msg: WorkerOutbound, transfer: Transferable[] = []): void {
  workerSelf.postMessage(msg, transfer);
}

// Route every debugger output line through `out` envelopes. Installed
// once at module init; the writer state lives on debug.ts itself.
setDebugWriter((s) => post({ type: "out", text: s }));

// Number of disassembled instructions to ship around PC on every
// tick. Cheap (a few microseconds even at 60 Hz) and gives the UI
// a stable scroll region without round-tripping per-instruction.
const DISASM_LINES = 16;

function snapshotCpu(machine: PC88Machine): CPUSnapshot {
  const { cpu } = machine;
  return {
    PC: cpu.regs.PC,
    SP: cpu.regs.SP,
    AF: cpu.regs.AF,
    BC: cpu.regs.BC,
    DE: cpu.regs.DE,
    HL: cpu.regs.HL,
    IX: cpu.regs.IX,
    IY: cpu.regs.IY,
    AF_: cpu.regs.AF_,
    BC_: cpu.regs.BC_,
    DE_: cpu.regs.DE_,
    HL_: cpu.regs.HL_,
    I: cpu.regs.I,
    R: cpu.regs.R,
    iff1: cpu.iff1,
    iff2: cpu.iff2,
    im: cpu.im,
    halted: cpu.halted,
    cycles: cpu.cycles,
  };
}

function snapshotDebug(s: State): DebugSnapshot {
  const ramWatches = [...s.debug.ramWatches.entries()].map(([addr, spec]) => ({
    addr,
    mode: spec.mode,
    action: spec.action,
  }));
  const portWatches = [...s.debug.portWatches.entries()].map(
    ([port, spec]) => ({ port, mode: spec.mode, action: spec.action }),
  );
  return {
    breakpoints: [...s.debug.breakpoints],
    ramWatches,
    portWatches,
    // Defensive copy — the worker's state.debug.callStack is mutated
    // in place by trackedStep, so structured cloning the live array
    // would race with the next instruction's push/pop.
    callStack: s.debug.callStack.map((f) => ({ ...f })),
  };
}

function disasmAround(
  machine: PC88Machine,
  pc: u16,
  lines: number,
  syms: DebugSymbols | null,
): DisasmLine[] {
  const read = (addr: u16) => machine.memBus.read(addr & 0xffff);
  const opts = syms
    ? { resolveLabel: syms.resolver, resolvePort: syms.portResolver }
    : {};
  const out: DisasmLine[] = [];
  let addr: u16 = pc & 0xffff;
  for (let i = 0; i < lines; i++) {
    const r = disassemble(read, addr, opts);
    const label = syms?.exactResolver(addr);
    out.push(
      label !== undefined
        ? { pc: addr, bytes: r.bytes, mnemonic: r.mnemonic, label }
        : { pc: addr, bytes: r.bytes, mnemonic: r.mnemonic },
    );
    addr = (addr + r.length) & 0xffff;
  }
  return out;
}

function postTick(s: State, type: "tick" | "stopped", reason?: string): void {
  const ascii = s.machine.display.toASCIIDump();
  const frame = s.machine.display.getTextFrame();
  // Copy chars into a fresh ArrayBuffer so the transfer doesn't
  // detach the live TVRAM-backed Uint8Array (it's a subarray of
  // mainRam; detaching would break the next frame).
  const charsBuf = new ArrayBuffer(frame.chars.length);
  new Uint8Array(charsBuf).set(frame.chars);
  const common = {
    ascii,
    chars: charsBuf,
    cols: frame.cols,
    rows: frame.rows,
    pc: s.machine.cpu.regs.PC,
    cycles: s.machine.cpu.cycles,
    ops: s.debug.ops,
    halted: s.machine.cpu.halted,
    cpu: snapshotCpu(s.machine),
    disasm: disasmAround(
      s.machine,
      s.machine.cpu.regs.PC,
      DISASM_LINES,
      s.syms,
    ),
    debug: snapshotDebug(s),
  };
  const msg: WorkerOutbound =
    type === "stopped"
      ? { type: "stopped", reason: reason ?? "stopped", ...common }
      : { type: "tick", ...common, running: s.running };
  post(msg, [charsBuf]);
}

function postPeek(s: State, addr: u16, count: number): void {
  const c = Math.max(0, Math.min(0x10000, count));
  const buf = new ArrayBuffer(c);
  const view = new Uint8Array(buf);
  for (let i = 0; i < c; i++)
    view[i] = s.machine.memBus.read((addr + i) & 0xffff);
  post({ type: "memory", addr: addr & 0xffff, bytes: buf }, [buf]);
}

// Single canonical run loop. Uses trackedStep so RAM/port watches
// fire, the call stack synthesises, and the PC ring buffer fills.
// Breakpoints + step-over targets stop the loop the same way
// dispatch's runUntilStop would, but yields back to the message
// queue every FRAME_CYCLES so pause / peek / typed REPL commands
// stay responsive.
function runFrame(s: State): void {
  if (!s.running) return;
  const target = s.machine.cpu.cycles + FRAME_CYCLES;
  while (s.machine.cpu.cycles < target) {
    if (s.machine.cpu.halted && !s.machine.cpu.iff1) {
      s.running = false;
      postTick(s, "stopped", "halted-no-irq");
      return;
    }
    trackedStep(s.machine, s.debug);
    if (s.debug.stopReason) {
      const reason = s.debug.stopReason;
      s.debug.stopReason = null;
      stopRunning(s);
      postTick(s, "stopped", reason);
      return;
    }
    const pc = s.machine.cpu.regs.PC;
    if (s.debug.stepOverTarget !== null && pc === s.debug.stepOverTarget) {
      s.debug.stepOverTarget = null;
      stopRunning(s);
      postTick(s, "stopped", `step-over @ ${hex4(pc)}`);
      return;
    }
    if (s.debug.breakpoints.has(pc)) {
      stopRunning(s);
      postTick(s, "stopped", `breakpoint @ ${hex4(pc)}`);
      return;
    }
  }
  postTick(s, "tick");
  s.loopHandle = setTimeout(() => runFrame(s), FRAME_INTERVAL_MS);
}

function hex4(v: number): string {
  return v.toString(16).padStart(4, "0");
}

function startRunning(s: State): void {
  if (s.running) return;
  s.running = true;
  runFrame(s);
}

function stopRunning(s: State): void {
  s.running = false;
  if (s.loopHandle !== null) {
    clearTimeout(s.loopHandle);
    s.loopHandle = null;
  }
}

function handleBoot(msg: Extract<WorkerInbound, { type: "boot" }>): void {
  const roms = new Map<ROMID, Uint8Array>();
  for (const [id, buf] of msg.roms) roms.set(id, new Uint8Array(buf));
  const loaded = loadRomsFromMap(msg.config, roms, md5);
  const machine = new PC88Machine(msg.config, loaded);
  machine.reset();
  const debug = makeDebugState();
  // installWatchHooks needs a `syms` slot for log-line label
  // formatting; pass null up front and rebind once the async load
  // resolves. The hooks read `state.syms` lazily through the
  // closure so the rebind is visible without re-installing.
  installWatchHooks(machine, debug, null);
  const s: State = {
    machine,
    running: false,
    loopHandle: null,
    debug,
    syms: null,
    loadedRoms: loaded,
  };
  state = s;
  log.info(`booted ${msg.config.model}`);
  post({ type: "ready" });
  postTick(s, "tick");
  // Kick off OPFS-backed symbol-file load. Surfaces a "labels
  // loaded" line on the REPL when it lands; failures are
  // non-fatal.
  void loadDebugSymbols(machine, loaded)
    .then((loadedSyms) => {
      if (state !== s) return;
      s.syms = loadedSyms;
      let count = 0;
      for (const e of loadedSyms.byRomId.values()) count += e.file.byAddr.size;
      count += loadedSyms.ramFile.byAddr.size;
      count += loadedSyms.portFile.byAddr.size;
      post({
        type: "out",
        text: `  ${count} labels loaded across ${loadedSyms.byRomId.size} ROMs + RAM/port files\n`,
      });
      // Re-tick so any disasm-side label-resolution refresh picks
      // up the freshly loaded symbols.
      postTick(s, "tick");
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`symbol load failed: ${message}`);
    });
}

// Step / next / continue have to flow through the worker's state
// machine — dispatch's versions call runUntilStop synchronously,
// which would block the message loop and prevent pause / peek /
// typed REPL commands from interleaving with a running emulator.
// Other commands (break / unbreak / watch / peek / regs / chips /
// label / …) flow through dispatch unchanged.
function doStep(s: State): void {
  stopRunning(s);
  if (s.machine.cpu.halted && !s.machine.cpu.iff1) {
    post({ type: "out", text: "  (HALT with IFF1=0; CPU is stuck)\n" });
    postTick(s, "tick");
    return;
  }
  trackedStep(s.machine, s.debug);
  if (s.debug.stopReason) {
    post({ type: "out", text: `  ${s.debug.stopReason}\n` });
    s.debug.stopReason = null;
  }
  postTick(s, "tick");
}

function doNext(s: State): void {
  stopRunning(s);
  const pc = s.machine.cpu.regs.PC;
  const op = s.machine.memBus.read(pc);
  const len = callOpLength(op);
  if (len !== null) {
    s.debug.stepOverTarget = (pc + len) & 0xffff;
    startRunning(s);
  } else {
    doStep(s);
  }
}

async function handleCommand(s: State, line: string): Promise<void> {
  const head = line.trim().split(/\s+/)[0]?.toLowerCase();
  switch (head) {
    case "s":
    case "step":
      doStep(s);
      return;
    case "n":
    case "next":
      doNext(s);
      return;
    case "c":
    case "cont":
    case "continue":
      startRunning(s);
      return;
  }
  // Other commands flow through the same dispatch the CLI uses.
  // syms is filled in asynchronously after handleBoot kicks off
  // loadDebugSymbols — until that resolves, label / unlabel /
  // labels surface a "symbols not loaded" line and no-op safely.
  // loadedRoms is omitted (not set to undefined) when null so the
  // exactOptionalPropertyTypes-narrowed DispatchCtx still matches.
  const opts = s.loadedRoms ? { loadedRoms: s.loadedRoms } : {};
  await dispatch(line, {
    machine: s.machine,
    state: s.debug,
    syms: s.syms,
    opts,
  });
  // The command may have set a breakpoint, mutated memory, etc.
  // Re-tick so the panels reflect the new state without the user
  // having to click anything.
  postTick(s, "tick");
}

workerSelf.addEventListener("message", (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "boot":
        if (state) stopRunning(state);
        handleBoot(msg);
        break;
      case "run":
        if (state) startRunning(state);
        break;
      case "pause":
        if (state) {
          stopRunning(state);
          postTick(state, "tick");
        }
        break;
      case "step":
        if (state) doStep(state);
        break;
      case "reset":
        if (state) {
          stopRunning(state);
          state.machine.reset();
          // Drop the debugger's bookkeeping too — call stack /
          // pcTrace / VBL counters all become invalid the moment
          // the CPU jumps back to 0x0000. Breakpoints + watches
          // are intentionally preserved across reset; the user set
          // them deliberately and would resent losing them on a
          // routine reboot.
          const fresh = makeDebugState([...state.debug.breakpoints]);
          fresh.ramWatches = state.debug.ramWatches;
          fresh.portWatches = state.debug.portWatches;
          state.debug.callStack = fresh.callStack;
          state.debug.ops = fresh.ops;
          state.debug.vbl = fresh.vbl;
          state.debug.pcTrace = fresh.pcTrace;
          state.debug.pcTraceWrite = fresh.pcTraceWrite;
          state.debug.pcTraceFilled = fresh.pcTraceFilled;
          state.debug.stopReason = null;
          state.debug.stepOverTarget = null;
          postTick(state, "tick");
        }
        break;
      case "peek":
        if (state) postPeek(state, msg.addr, msg.count);
        break;
      case "key":
        if (state) {
          if (msg.down) state.machine.keyboard.pressKey(msg.row, msg.col);
          else state.machine.keyboard.releaseKey(msg.row, msg.col);
        }
        break;
      case "keysAllUp":
        if (state) state.machine.keyboard.releaseAll();
        break;
      case "command":
        if (state) {
          // Fire-and-forget — handleCommand awaits dispatch then
          // re-ticks; errors land in the catch block via the
          // outer event handler chain below (we re-use the same
          // try/catch around message dispatch in this listener).
          void handleCommand(state, msg.line).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`command "${msg.line}" failed: ${message}`);
            post({ type: "error", message });
          });
        }
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`worker error: ${message}`);
    post({ type: "error", message });
  }
});

post({ type: "ready" });
