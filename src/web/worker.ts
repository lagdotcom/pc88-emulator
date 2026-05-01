import { disassemble } from "../chips/z80/disasm.js";
import type { ROMID, u16 } from "../flavours.js";
import { getLogger } from "../log.js";
import {
  type DebugState,
  dispatch,
  installWatchHooks,
  makeDebugState,
  setDebugWriter,
} from "../machines/debug.js";
import {
  makeVblState,
  PC88Machine,
  pumpVbl,
  stepOneInstruction,
  VBL_HZ,
  type VblState,
} from "../machines/pc88.js";
import { loadRomsFromMap } from "../machines/rom-loader-browser.js";
import { md5 } from "./md5.js";
import type {
  CPUSnapshot,
  DisasmLine,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";

const log = getLogger("web/worker");

// Run loop: per wall-clock tick advance the emulator by one VBL
// period's worth of CPU cycles, then post a frame update. 60 Hz wall
// pacing comes from setTimeout — close enough for first-light; rAF
// isn't available in workers, and OffscreenCanvas-driven rAF lives
// behind the canvas renderer that's still phase 3.
const Z80_HZ = 4_000_000;
const FRAME_CYCLES = Math.round(Z80_HZ / VBL_HZ);
const FRAME_INTERVAL_MS = Math.round(1000 / VBL_HZ);

interface State {
  machine: PC88Machine;
  vbl: VblState;
  ops: number;
  running: boolean;
  loopHandle: ReturnType<typeof setTimeout> | null;
  debug: DebugState;
}

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

function disasmAround(
  machine: PC88Machine,
  pc: u16,
  lines: number,
): DisasmLine[] {
  const read = (addr: u16) => machine.memBus.read(addr & 0xffff);
  const out: DisasmLine[] = [];
  let addr: u16 = pc & 0xffff;
  for (let i = 0; i < lines; i++) {
    const r = disassemble(read, addr);
    out.push({ pc: addr, bytes: r.bytes, mnemonic: r.mnemonic });
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
    ops: s.ops,
    halted: s.machine.cpu.halted,
    cpu: snapshotCpu(s.machine),
    disasm: disasmAround(s.machine, s.machine.cpu.regs.PC, DISASM_LINES),
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

function runFrame(s: State): void {
  if (!s.running) return;
  const target = s.machine.cpu.cycles + FRAME_CYCLES;
  while (s.machine.cpu.cycles < target) {
    pumpVbl(s.machine, s.vbl);
    if (s.machine.cpu.halted && !s.machine.cpu.iff1) {
      s.running = false;
      postTick(s, "stopped", "halted-no-irq");
      return;
    }
    s.machine.cpu.runOneOp();
    s.ops++;
  }
  postTick(s, "tick");
  s.loopHandle = setTimeout(() => runFrame(s), FRAME_INTERVAL_MS);
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
  // The watch-hook installer monkey-patches memBus.read/write +
  // ioBus.tracer so RAM and port watches fire on access. No symbol
  // file in the browser bundle — pass null and the hooks render
  // bare hex labels in their log lines.
  installWatchHooks(machine, debug, null);
  state = {
    machine,
    vbl: makeVblState(),
    ops: 0,
    running: false,
    loopHandle: null,
    debug,
  };
  log.info(`booted ${msg.config.model}`);
  post({ type: "ready" });
  postTick(state, "tick");
}

async function handleCommand(s: State, line: string): Promise<void> {
  // syms = null for now; phase 4b/c may swap in OPFS-backed labels.
  const ctx = {
    machine: s.machine,
    state: s.debug,
    syms: null,
    opts: {},
  };
  await dispatch(line, ctx);
  // The debugger may have stepped, set a breakpoint, mutated memory,
  // etc. Re-tick so the panels reflect the new state without the
  // user having to click anything.
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
        if (state && !state.running) {
          pumpVbl(state.machine, state.vbl);
          stepOneInstruction(state.machine);
          state.ops++;
          postTick(state, "tick");
        }
        break;
      case "reset":
        if (state) {
          stopRunning(state);
          state.machine.reset();
          state.vbl = makeVblState();
          state.ops = 0;
          postTick(state, "tick");
        }
        break;
      case "peek":
        if (state) postPeek(state, msg.addr, msg.count);
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
