import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";

const log = logLib.get("calendar");

// Real-time-clock + cassette-strobe I/O at port 0x10. The mkI uses
// this port for both the calendar serial-clock pulses and the
// cassette load/save strobe. Reads return 0 (no cassette data
// pending); writes are accepted and the first one is logged.
export class Calendar {
  private warned = false;

  register(bus: IOBus): void {
    bus.register(0x10, {
      name: "calendar",
      read: () => 0x00,
      write: (_p, v) => {
        if (!this.warned) {
          this.warned = true;
          log.info(`first calendar write 0x${v.toString(16)}`);
        }
      },
    });
  }
}
