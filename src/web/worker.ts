import type { ROMID } from "../flavours.js";
import { getLogger } from "../log.js";
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
import type { WorkerInbound, WorkerOutbound } from "./protocol.js";

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
}

let state: State | null = null;

const workerSelf = self as unknown as Worker;

function post(msg: WorkerOutbound, transfer: Transferable[] = []): void {
  workerSelf.postMessage(msg, transfer);
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
  };
  const msg: WorkerOutbound =
    type === "stopped"
      ? { type: "stopped", reason: reason ?? "stopped", ...common }
      : { type: "tick", ...common, running: s.running };
  post(msg, [charsBuf]);
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
  state = {
    machine,
    vbl: makeVblState(),
    ops: 0,
    running: false,
    loopHandle: null,
  };
  log.info(`booted ${msg.config.model}`);
  post({ type: "ready" });
  postTick(state, "tick");
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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`worker error: ${message}`);
    post({ type: "error", message });
  }
});

post({ type: "ready" });
