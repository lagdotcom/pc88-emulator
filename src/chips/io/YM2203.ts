import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";

const log = logLib.get("opn");

// YM2203 (OPN) — Yamaha sound chip introduced on PC-8801 mkII SR.
// Standard Yamaha register-then-data interface:
//
//   0x44  W  address latch (selects internal register 0x00..0xFF)
//   0x45  RW data port (R = status / register read, W = register write)
//
// FH/MA replace this with YM2608 (OPNA) at 0x44-0x47 — same 0x44/0x45
// pair plus a second pair 0x46/0x47 for the OPNA's extra register
// bank. We only stub OPN here; OPNA can extend the same module.
//
// The chip integrates a 3-channel FM synthesiser, a 3-channel SSG
// (AY-3-8910 compatible), a timer pair, and an IRQ output. None of
// it is generated here — the stub latches the address byte, swallows
// data writes, and returns an idle status so software polling
// "is the timer interrupt pending" gives up.
//
// Status byte (read at 0x45 when no register-read is in progress):
//   bit 7  BUSY (1 = chip processing previous write; we always 0)
//   bit 6-2 reserved
//   bit 1  TIMER B overflow (0 = none)
//   bit 0  TIMER A overflow (0 = none)
// Idle = 0x00.
export interface YM2203Snapshot {
  addr: u8;
  // Last-written value per register (0x00..0xFF). Real chip has
  // sparse register layout; we just latch every write.
  regs: u8[];
}

export class YM2203 {
  private addr: u8 = 0;
  private readonly regs: Uint8Array = new Uint8Array(256);

  snapshot(): YM2203Snapshot {
    return { addr: this.addr, regs: Array.from(this.regs) };
  }

  fromSnapshot(s: YM2203Snapshot): void {
    this.addr = s.addr;
    for (let i = 0; i < 256; i++) this.regs[i] = s.regs[i] ?? 0;
  }

  register(bus: IOBus): void {
    bus.register(0x44, {
      name: "opn/addr",
      // Reading the address port is undefined on real silicon; some
      // titles read it expecting 0xFF or the last-written addr.
      // 0xFF matches the bus-default and keeps things quiet.
      read: () => 0xff,
      write: (_p, v) => {
        this.addr = v;
      },
    });
    bus.register(0x45, {
      name: "opn/data",
      read: () => 0x00,
      write: (_p, v) => {
        this.regs[this.addr] = v;
        // No actual sound generation yet — every register write is a
        // no-op. Surface as a warning so the BIOS's first
        // sound-init pass is visible in the log without grep.
        log.warn(
          `reg 0x${this.addr.toString(16)} := 0x${v.toString(16)} (stub)`,
        );
      },
    });
  }
}
