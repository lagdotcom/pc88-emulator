import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";

const log = logLib.get("ppi");

// 8255 PPI stub. mkI has one PPI used as a keyboard-scan port at
// 0x00–0x03 (rows on port A, columns selected on port B). Sub-CPU
// PPI #2 at 0xFC–0xFF only exists on mkII+; we ignore it.
//
// Reads return 0xFF (= "no key pressed" — the matrix is active-low).
// Writes are accepted and logged once per port.
export class Ppi8255 {
  private warned = new Set<number>();

  register(bus: IOBus): void {
    for (let p = 0x00; p <= 0x03; p++) {
      bus.register(p, {
        name: `ppi-key/${p.toString(16)}`,
        read: () => 0xff,
        write: (port, v) => this.warn(port, v),
      });
    }
  }

  private warn(port: number, value: number): void {
    if (this.warned.has(port)) return;
    this.warned.add(port);
    log.debug(
      `first PPI write 0x${port.toString(16)} = 0x${value.toString(16)}`,
    );
  }
}
