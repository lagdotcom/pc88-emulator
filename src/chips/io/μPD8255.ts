import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import { getLogger } from "../../log.js";
import { byte } from "../../tools.js";

const log = getLogger("ppi");

// μPD8255 PPI — sub-CPU IPC bridge on PC-88 mkII+. The same chip is
// exposed on both the main CPU's I/O bus (ports 0xFC-0xFF) and the
// sub-CPU's I/O bus (also 0xFC-0xFF on its own bus).
//
// Per MAME's `pc80s31k` device: this is modelled as two i8255 PPIs
// wired together with a PA↔PB crossover. From software on EITHER
// side, the convention is:
//
//   port A (0xFC) — OUTGOING.  Write to send a byte to the other side.
//   port B (0xFD) — INCOMING.  Read to receive a byte from the other.
//   port C (0xFE) — handshake bits + control. Symmetric pass-through.
//   ctrl   (0xFF) — i8255 mode word / port-C bit set-reset.
//
// Six latches model the per-direction byte values held on the cross-
// wired pins (one latch per port direction per side):
//
//   host PA-out → sub PB-in          host PB-out → sub PA-in
//   sub  PA-out → host PB-in          sub  PB-out → host PA-in
//   host PC-out → sub PC-in           sub  PC-out → host PC-in
//
// Real hardware also rotates the port-C handshake bits between sides
// (writer uses PC[4..7], reader sees PC[0..2] in MAME's pc80s31k —
// the PC-88 motherboard pin remap). That bit rotation is left as a
// TODO; it only matters when the FDC sub-CPU runs and exercises the
// strobe / data-accepted protocol. The BIOS init path that the smoke
// tests reach today doesn't depend on it.

export interface PPISnapshot {
  readonly latches: number[];
  readonly mainControl: u8;
  readonly subControl: u8;
  readonly mainHasFresh: boolean;
  readonly subHasFresh: boolean;
}

const enum L {
  HostPaOut_SubPbIn = 0,
  HostPbOut_SubPaIn = 1,
  HostPcOut_SubPcIn = 2,
  SubPaOut_HostPbIn = 3,
  SubPbOut_HostPaIn = 4,
  SubPcOut_HostPcIn = 5,
}

export class μPD8255 {
  private latches = new Uint8Array(6);
  private mainControl: u8 = 0;
  private subControl: u8 = 0;

  // High-level "fresh data waiting" flags, used by future sub-CPU
  // scheduler to know when to wake the FDC ROM. Set when the sender
  // writes outgoing port A; cleared when the receiver reads its
  // incoming port B.
  private subHasFresh = false;
  private mainHasFresh = false;

  registerMain(bus: IOBus, basePort = 0xfc): void {
    bus.register(basePort, {
      name: "ppi/A(main)",
      read: () => this.latches[L.SubPbOut_HostPaIn]!,
      write: (_port, value) => {
        this.latches[L.HostPaOut_SubPbIn] = value;
        this.subHasFresh = true;
        log.info(`A out=${byte(value)} (main→sub)`);
      },
    });
    bus.register(basePort + 1, {
      name: "ppi/B(main)",
      read: () => {
        const v = this.latches[L.SubPaOut_HostPbIn]!;
        this.mainHasFresh = false;
        return v;
      },
      write: (_port, value) => {
        this.latches[L.HostPbOut_SubPaIn] = value;
      },
    });
    bus.register(basePort + 2, {
      name: "ppi/C(main)",
      read: () => this.latches[L.SubPcOut_HostPcIn]!,
      write: (_port, value) => {
        this.latches[L.HostPcOut_SubPcIn] = value;
      },
    });
    bus.register(basePort + 3, {
      name: "ppi/ctrl(main)",
      read: () => 0xff,
      write: (_port, value) => this.handleControl("main", value),
    });
  }

  registerSub(bus: IOBus, basePort = 0xfc): void {
    bus.register(basePort, {
      name: "ppi/A(sub)",
      read: () => this.latches[L.HostPbOut_SubPaIn]!,
      write: (_port, value) => {
        this.latches[L.SubPaOut_HostPbIn] = value;
        this.mainHasFresh = true;
        log.info(`A out=${byte(value)} (sub→main)`);
      },
    });
    bus.register(basePort + 1, {
      name: "ppi/B(sub)",
      read: () => {
        const v = this.latches[L.HostPaOut_SubPbIn]!;
        this.subHasFresh = false;
        return v;
      },
      write: (_port, value) => {
        this.latches[L.SubPbOut_HostPaIn] = value;
      },
    });
    bus.register(basePort + 2, {
      name: "ppi/C(sub)",
      read: () => this.latches[L.HostPcOut_SubPcIn]!,
      write: (_port, value) => {
        this.latches[L.SubPcOut_HostPcIn] = value;
      },
    });
    bus.register(basePort + 3, {
      name: "ppi/ctrl(sub)",
      read: () => 0xff,
      write: (_port, value) => this.handleControl("sub", value),
    });
  }

  // i8255 control register: bit 7 = 1 selects a mode word, bit 7 = 0
  // does a port-C bit set/reset on that side's outgoing C latch.
  // Modes themselves don't gate behaviour yet (we model mode 0 with
  // independent port directions); the byte is latched so a snapshot
  // round-trips intact.
  private handleControl(side: "main" | "sub", value: u8): void {
    if (value & 0x80) {
      if (side === "main") this.mainControl = value;
      else this.subControl = value;
      log.info(`${side} mode word=${byte(value)}`);
      return;
    }
    const bit = (value >>> 1) & 0x07;
    const set = (value & 0x01) !== 0;
    const mask = 1 << bit;
    const slot = side === "main" ? L.HostPcOut_SubPcIn : L.SubPcOut_HostPcIn;
    const cur = this.latches[slot]!;
    this.latches[slot] = set ? (cur | mask) : (cur & ~mask);
  }

  snapshot(): PPISnapshot {
    return {
      latches: Array.from(this.latches),
      mainControl: this.mainControl,
      subControl: this.subControl,
      mainHasFresh: this.mainHasFresh,
      subHasFresh: this.subHasFresh,
    };
  }

  fromSnapshot(s: PPISnapshot): void {
    this.latches.set(s.latches);
    this.mainControl = s.mainControl;
    this.subControl = s.subControl;
    this.mainHasFresh = s.mainHasFresh;
    this.subHasFresh = s.subHasFresh;
  }

  // Direct-poke helpers + flag accessors for tests + the future
  // sub-CPU subsystem (which will want to drive the latches without
  // going through its IOBus during scheduler wake-ups).
  pokeMainOutgoing(value: u8): void {
    this.latches[L.HostPaOut_SubPbIn] = value;
    this.subHasFresh = true;
  }
  pokeSubOutgoing(value: u8): void {
    this.latches[L.SubPaOut_HostPbIn] = value;
    this.mainHasFresh = true;
  }
  hasFreshForSub(): boolean {
    return this.subHasFresh;
  }
  hasFreshForMain(): boolean {
    return this.mainHasFresh;
  }
}
