import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";

const log = logLib.get("misc-io");

// Catch-all for the handful of low-traffic ports the mkI BASIC ROM
// init path touches that don't belong to any other chip stub. None of
// these are functionally important for first-light: returning idle /
// 0xff and discarding writes is enough to keep the BIOS advancing.
//
//   0xE7  write  — alternate IRQ mask on later models; mkI no-op
//   0xF8  write  — boot-mode / FDD-IF select on later models; mkI no-op
//
// We register them explicitly (rather than relying on the IOBus
// noisy-once default) so they don't pollute the diagnostics when the
// BIOS is doing its routine init pokes. If a future model needs real
// behaviour here, register a more specific stub before this one.
export class MiscPorts {
  // Track whether each port has been touched, for end-of-run
  // diagnostics ("did the BIOS write to F8, and with what?").
  lastE7: number | null = null;
  lastF8: number | null = null;

  register(bus: IOBus): void {
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
