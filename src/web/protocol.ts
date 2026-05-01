import type { ROMID, u8, u16 } from "../flavours.js";
import type { PC88Config } from "../machines/config.js";

// Message protocol between web main thread (UI) and the emulator
// worker. Inbound is what the UI sends to the worker; Outbound is the
// worker's replies. Boot bytes ride as transferable ArrayBuffers so a
// 256 KB ROM set doesn't get structured-cloned across threads.

export type WorkerInbound =
  | {
      type: "boot";
      config: PC88Config;
      roms: Array<[ROMID, ArrayBuffer]>;
    }
  | { type: "run" }
  | { type: "pause" }
  | { type: "step" }
  | { type: "reset" }
  | { type: "peek"; addr: u16; count: number }
  | { type: "command"; line: string };

// CPU state snapshot. Subset of PC88Machine.snapshot().cpu — the same
// shape but extracted into its own type so the UI panels can refer
// to it without importing the whole MachineSnapshot.
export interface CPUSnapshot {
  PC: u16;
  SP: u16;
  AF: u16;
  BC: u16;
  DE: u16;
  HL: u16;
  IX: u16;
  IY: u16;
  AF_: u16;
  BC_: u16;
  DE_: u16;
  HL_: u16;
  I: u8;
  R: u8;
  iff1: boolean;
  iff2: boolean;
  im: number;
  halted: boolean;
  cycles: number;
}

export interface DisasmLine {
  pc: u16;
  bytes: u8[];
  mnemonic: string;
}

export type WorkerOutbound =
  | { type: "ready" }
  | {
      type: "tick";
      ascii: string;
      // TextFrame chars (cols * rows bytes) shipped as a transferable
      // ArrayBuffer so 60 Hz frame updates don't structured-clone an
      // 80×20 array into the UI thread. The UI re-views as Uint8Array
      // and feeds it to the canvas renderer.
      chars: ArrayBuffer;
      cols: number;
      rows: number;
      pc: u16;
      cycles: number;
      ops: number;
      running: boolean;
      halted: boolean;
      cpu: CPUSnapshot;
      disasm: DisasmLine[];
      // Active code breakpoints — let the UI mark disassembly rows.
      // Sorted-not-required; the disasm panel does a Set lookup.
      breakpoints: u16[];
    }
  | {
      type: "stopped";
      reason: string;
      ascii: string;
      chars: ArrayBuffer;
      cols: number;
      rows: number;
      pc: u16;
      cycles: number;
      ops: number;
      halted: boolean;
      cpu: CPUSnapshot;
      disasm: DisasmLine[];
      breakpoints: u16[];
    }
  | {
      type: "memory";
      addr: u16;
      // Memory bytes shipped as a transferable buffer; the UI re-views
      // as Uint8Array and renders a hex line.
      bytes: ArrayBuffer;
    }
  // Buffered stdout from the worker's debugger dispatch — flushed in
  // chunks so the REPL pane can append plain text.
  | { type: "out"; text: string }
  | { type: "error"; message: string };
