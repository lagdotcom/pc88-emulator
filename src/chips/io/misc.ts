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
//   0xEB  write  — extra port the kanji ROM area logs; covered by
//                  KanjiROM's 0xE8-0xEB registration.
//   0xE7  write  — alternate IRQ mask on later models; mkI no-op
//   0xF8  write  — boot-mode / FDD-IF select on later models; mkI no-op
//
// We register them explicitly (rather than relying on the IOBus
// noisy-once default) so they don't pollute the diagnostics when the
// BIOS is doing its routine init pokes. If a future model needs real
// behaviour here, register a more specific stub before this one.
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
      write: (_p, v) => log.info(`0xc8 (RS232 ch1 gate) := 0x${v.toString(16)}`),
    });
    bus.register(0xca, {
      name: "misc/0xca",
      write: (_p, v) => log.info(`0xca (RS232 ch2 gate) := 0x${v.toString(16)}`),
    });
    bus.register(0xe7, {
      name: "misc/0xe7",
      write: (_p, v) => {
        this.lastE7 = v;
        log.info(`0xe7 := 0x${v.toString(16)}`);
      },
    });
    bus.register(0xf8, {
      name: "misc/0xf8",
      write: (_p, v) => {
        this.lastF8 = v;
        log.info(`0xf8 := 0x${v.toString(16)}`);
      },
    });
  }
}
