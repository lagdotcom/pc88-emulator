import logLib from "log";

import type { IOBus } from "../core/IOBus.js";
import type { u8 } from "../flavours.js";
import { byte } from "../tools.js";
import type { PC88MemoryMap } from "./pc88-memory.js";

const log = logLib.get("display-regs");

// Display-control register block. Lives inside the PC-88 system gate
// array — there's no separate silicon part for these registers, but
// they form a coherent group: palette + layer mask + GVRAM plane
// select. MAME models them as methods on `pc8801_state` rather than a
// device class; we collect them here so the responsibility stays out
// of `sysctrl.ts` (system control) and `pc88-display.ts` (headless
// frame capture surface).
//
// Port map (per MAME pc8801.cpp):
//
//   0x52       W   bgpal_w        border + background colour
//   0x53       W   layer_masking  per-layer show/hide
//   0x54-0x5B  W   palram_w       palette RAM (8 colour entries)
//   0x5C-0x5F  RW  vram_select    GVRAM plane select (port-low-2 = plane)
//
// Plane selection at 0x5C-0x5F: real silicon uses the *port number*
// low 2 bits as the plane index, not the data byte — writing
// anything to 0x5C selects plane 0, 0x5D plane 1, 0x5E plane 2, and
// 0x5F enters a special mode (vram_sel=3, which MAME's vram_select_r
// returns as 0xf8 distinguishing it from the bit-set per-plane
// readback). Our `PC88MemoryMap.setGVRAMPlane` only accepts 0..2,
// so we ignore the 0x5F mode for now — no first-light path uses it.
export interface DisplayRegistersSnapshot {
  bgColor: u8;
  showText: boolean;
  showGVRAM0: boolean;
  showGVRAM1: boolean;
  showGVRAM2: boolean;
  showGVRAM3: boolean;
  // 0..3 — the latched GVRAM plane index for readback at 0x5C.
  vramSel: 0 | 1 | 2 | 3;
}

export class DisplayRegisters {
  bgColor: u8 = 0;
  showText = false;
  showGVRAM0 = false;
  showGVRAM1 = false;
  showGVRAM2 = false;
  showGVRAM3 = false;
  vramSel: 0 | 1 | 2 | 3 = 0;

  constructor(private readonly memoryMap: PC88MemoryMap) {}

  snapshot(): DisplayRegistersSnapshot {
    return {
      bgColor: this.bgColor,
      showText: this.showText,
      showGVRAM0: this.showGVRAM0,
      showGVRAM1: this.showGVRAM1,
      showGVRAM2: this.showGVRAM2,
      showGVRAM3: this.showGVRAM3,
      vramSel: this.vramSel,
    };
  }

  fromSnapshot(s: DisplayRegistersSnapshot): void {
    this.bgColor = s.bgColor;
    this.showText = s.showText;
    this.showGVRAM0 = s.showGVRAM0;
    this.showGVRAM1 = s.showGVRAM1;
    this.showGVRAM2 = s.showGVRAM2;
    this.showGVRAM3 = s.showGVRAM3;
    this.vramSel = s.vramSel;
  }

  register(bus: IOBus): void {
    bus.register(0x52, {
      name: "display/bgpal",
      write: (_p, v) => {
        this.bgColor = (v & 0x70) >> 4;
        log.info(`0x52 write: bgColor=${byte(v)}`);
      },
    });

    bus.register(0x53, {
      name: "display/layer-mask",
      write: (_p, v) => {
        this.showText = (v & 0x01) === 0;
        this.showGVRAM0 = (v & 0x02) === 0;
        this.showGVRAM1 = (v & 0x04) === 0;
        this.showGVRAM2 = (v & 0x08) === 0;
        this.showGVRAM3 = (v & 0x10) === 0;
        log.info(
          `0x53 write: text=${this.showText} g0=${this.showGVRAM0} g1=${this.showGVRAM1} g2=${this.showGVRAM2} g3=${this.showGVRAM3}`,
        );
      },
    });

    for (let i = 0; i < 8; i++) {
      const port = 0x54 + i;
      bus.register(port, {
        name: `display/pal${i}`,
        write: (_p, v) => {
          log.info(`pal${i} := 0x${byte(v)}`);
        },
      });
    }

    // 0x5C-0x5F: GVRAM plane select. The port number's low 2 bits are
    // the plane index; the data byte is ignored. Reads at 0x5C return
    // a one-hot active-low encoding of the current plane (or 0 in mode
    // 3) — see MAME `vram_select_r`.
    for (let i = 0; i < 4; i++) {
      const port = 0x5c + i;
      const planeIdx = i as 0 | 1 | 2 | 3;
      bus.register(port, {
        name: `display/vram-sel${i}`,
        // MAME's vram_select_r is registered only on 0x5C, but reading
        // any port in this group at the bus level is harmless; mirror
        // the same readback shape on each so a misaligned read still
        // returns something sensible.
        read: () => (this.vramSel === 3 ? 0xf8 : 0xf8 | (1 << this.vramSel)),
        write: (_p, _v) => this.selectPlane(planeIdx),
      });
    }
  }

  private selectPlane(idx: 0 | 1 | 2 | 3): void {
    this.vramSel = idx;
    // Mode 3 is "TVRAM bank as plane" / a special access mode no
    // first-light boot path exercises. Log so we notice if anything
    // does start using it; otherwise apply the plane to memory map.
    if (idx === 3) {
      log.info(`vram_sel=3 (special mode, not implemented)`);
      return;
    }
    this.memoryMap.setGVRAMPlane(idx);
  }
}
