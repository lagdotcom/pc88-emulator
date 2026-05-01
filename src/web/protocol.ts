import type { ROMID, u16 } from "../flavours.js";
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
  | { type: "reset" };

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
    }
  | { type: "error"; message: string };
