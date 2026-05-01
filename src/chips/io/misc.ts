import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";

const log = logLib.get("misc-io");

// Catch-all for the handful of low-traffic ports the mkI BASIC ROM
// init path touches that don't belong to any other chip stub. None of
// these are functionally important for first-light: returning idle /
// 0xff and discarding writes is enough to keep the BIOS advancing.
//
//   0xC8  write  — RS-232C ch.1 "prohibited gate" (per MAME). N88
//                  init writes this unconditionally; behaviour seems
//                  to be a no-op enable/disable latch.
//   0xCA  write  — RS-232C ch.2 "prohibited gate" — same shape as 0xC8.
//   0xE7  write  — alternate IRQ mask on later models; mkI no-op.
//   0xF4  read   — 5.25" floppy DMA control card detect. Returns 0xFF
//                  (= card not present) so BIOS skips that init path.
//                  Per MAME's commented-out "map(0xf4, 0xf7) DMA 5'25-
//                  inch floppy" line.
//   0xF8  read+w — 8" floppy DMA control card detect (read) + boot/
//                  FDD-IF select on later models (write). Returns
//                  0xFF on read; latches writes.
//
// We register them explicitly (rather than relying on the IOBus
// noisy-once default) so they don't pollute the diagnostics when the
// BIOS is doing its routine init pokes. Stub writes log at warn so
// the unimplemented behaviour stays visible.
export interface MiscPortsSnapshot {
  lastE7: u8 | null;
  lastF8: u8 | null;
}

export class MiscPorts {
  // Track whether each port has been touched, for end-of-run
  // diagnostics ("did the BIOS write to F8, and with what?").
  lastE7: u8 | null = null;
  lastF8: u8 | null = null;

  snapshot(): MiscPortsSnapshot {
    return { lastE7: this.lastE7, lastF8: this.lastF8 };
  }

  fromSnapshot(s: MiscPortsSnapshot): void {
    this.lastE7 = s.lastE7;
    this.lastF8 = s.lastF8;
  }

  register(bus: IOBus): void {
    bus.register(0xc8, {
      name: "misc/0xc8",
      write: (_p, v) =>
        log.warn(`0xc8 (RS232 ch1 gate) := 0x${v.toString(16)} (stub)`),
    });
    bus.register(0xca, {
      name: "misc/0xca",
      write: (_p, v) =>
        log.warn(`0xca (RS232 ch2 gate) := 0x${v.toString(16)} (stub)`),
    });
    bus.register(0xe7, {
      name: "misc/0xe7",
      write: (_p, v) => {
        this.lastE7 = v;
        log.warn(`0xe7 := 0x${v.toString(16)} (stub)`);
      },
    });
    bus.register(0xf4, {
      name: "misc/0xf4",
      // 5.25" floppy DMA card detect — return 0xFF = "not present".
      read: () => 0xff,
    });
    bus.register(0xf8, {
      name: "misc/0xf8",
      // 8" floppy DMA card detect — return 0xFF = "not present".
      read: () => 0xff,
      write: (_p, v) => {
        this.lastF8 = v;
        log.warn(`0xf8 := 0x${v.toString(16)} (stub)`);
      },
    });
  }
}
