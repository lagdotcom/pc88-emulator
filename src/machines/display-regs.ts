import type { IOBus } from "../core/IOBus.js";
import type { u8 } from "../flavours.js";
import { byte } from "../tools.js";
import type { PC88MemoryMap } from "./pc88-memory.js";
import { getLogger } from "../log.js";

const log = getLogger("display-regs");

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
//   0x5C-0x5F  RW  vram_select    GVRAM plane select / main-RAM toggle
//
// VRAM-window selection at 0x5C-0x5F: real silicon uses the *port
// number* low 2 bits as the selector, not the data byte. Writing to
//
//   0x5C  →  GVRAM plane 0 visible at 0xC000-0xEFFF
//   0x5D  →  GVRAM plane 1
//   0x5E  →  GVRAM plane 2
//   0x5F  →  main RAM at 0xC000-0xEFFF (GVRAM hidden)
//
// MAME's `vram_select_r` returns a one-hot encoding bit for sel 0..2
// and a flat `0xf8` for sel 3 — that's the diagnostic for "main RAM"
// mode (no plane bit set). We mirror the readback on every port in
// the group so misaligned reads still return something sensible.

// Port 0x52 (border + background colour). Bits 4-6 are the BG pen,
// bits 0-2 the border. Per MAME `bgpal_w`.
const PORT52 = {
  BG_MASK: 0b0111_0000,
  BG_SHIFT: 4,
  BORDER_MASK: 0b0000_0111,
} as const;

// Port 0x53 (layer mask). Active-low: a 0 bit means "this layer
// visible", a 1 bit hides it. Per MAME `layer_masking_w`.
const PORT53 = {
  HIDE_TEXT: 1 << 0,
  HIDE_GVRAM0: 1 << 1,
  HIDE_GVRAM1: 1 << 2,
  HIDE_GVRAM2: 1 << 3,
  HIDE_GVRAM3: 1 << 4,
} as const;

// Port 0x5C-0x5F (GVRAM plane select). The selector is the port's
// low 2 bits (the data byte is ignored). 0..2 pick GVRAM planes;
// 3 hides GVRAM and exposes main RAM at 0xC000-0xEFFF.
const VRAM_SEL = {
  PLANE_0: 0,
  PLANE_1: 1,
  PLANE_2: 2,
  MAIN_RAM: 3,
  // Readback shape: `READBACK_BASE | (1 << sel)` for plane modes;
  // `READBACK_BASE` (no plane bit) for main-RAM mode. Per MAME
  // `vram_select_r`.
  READBACK_BASE: 0xf8,
} as const;

export interface DisplayRegistersSnapshot {
  bgColor: u8;
  showText: boolean;
  showGVRAM0: boolean;
  showGVRAM1: boolean;
  showGVRAM2: boolean;
  showGVRAM3: boolean;
  // 0..3 — the latched GVRAM plane index for readback at 0x5C.
  vramSel: 0 | 1 | 2 | 3;
  // 0 = digital palette (1 byte/entry), 1 = analogue (2 bytes/entry).
  // Driven by sysctrl port 0x32 bit 5 (PMODE) via setPMode().
  pmode: 0 | 1;
  // Palette RAM at ports 0x54-0x5B. Eight entries:
  //   digital  → low byte holds the 3-bit GRB code (bits 0-2)
  //   analogue → low byte = G+R packed, high byte = B + sentinel
  // The two halves are kept distinct in the snapshot so a future
  // savestate restore (and the live renderer once it lands) can pick
  // out either field without re-deriving from a packed value.
  palramLow: number[];
  palramHigh: number[];
  // Per-port toggle state for the 2-byte analogue protocol. `true`
  // = next write to that port lands in palramHigh; `false` = next
  // write lands in palramLow. Reset on PMODE flip.
  palramHighNext: boolean[];
}

export class DisplayRegisters {
  bgColor: u8 = 0;
  showText = false;
  showGVRAM0 = false;
  showGVRAM1 = false;
  showGVRAM2 = false;
  showGVRAM3 = false;
  vramSel: 0 | 1 | 2 | 3 = 0;
  // Palette mode. 0 = digital (mkI/mkII; 1 byte/port, 8-colour fixed
  // GRB), 1 = analogue (SR+; 2 bytes/port, 8 levels each of R/G/B).
  // Toggled by sysctrl writing port 0x32 bit 5 (see setPMode).
  pmode: 0 | 1 = 0;
  // Palette RAM. Each of the 8 entries has a low + high byte:
  //   - digital mode: only `palramLow` is meaningful; high stays 0.
  //     Pre-SR BIOS writes 1 byte per port in arbitrary order.
  //   - analogue mode: low first (G+R), high second (B + sentinel).
  //     SR's V2-mode init at sr-n88 0x3D87 calls 0x3962, which loops
  //     `OUT (C),A` twice per port with INC HL between — i.e. two
  //     consecutive writes to the same port with the second being
  //     the high byte. Per-port toggle below tracks "next byte".
  readonly palramLow = new Uint8Array(8);
  readonly palramHigh = new Uint8Array(8);
  // `true` for entry i means the next write to port (0x54+i) lands
  // in palramHigh[i]; `false` means it lands in palramLow[i] and
  // flips the flag. All 8 reset to `false` whenever PMODE flips
  // (see setPMode) so a digital→analogue transition starts each
  // port in a known "expecting low byte" state.
  readonly palramHighNext: boolean[] = new Array(8).fill(false);

  constructor(private readonly memoryMap: PC88MemoryMap) {}

  // Called by SystemController whenever port 0x32 bit 5 (PMODE)
  // changes value. Resets the per-port toggle state so the BIOS
  // can rely on "first byte after pmode change is low byte" — that
  // matches the SR boot sequence at sr-n88 0x3D7B which writes
  // 0xA8 (PMODE=1) before issuing the first palette byte.
  setPMode(pmode: 0 | 1): void {
    this.pmode = pmode;
    for (let i = 0; i < 8; i++) this.palramHighNext[i] = false;
  }

  snapshot(): DisplayRegistersSnapshot {
    return {
      bgColor: this.bgColor,
      showText: this.showText,
      showGVRAM0: this.showGVRAM0,
      showGVRAM1: this.showGVRAM1,
      showGVRAM2: this.showGVRAM2,
      showGVRAM3: this.showGVRAM3,
      vramSel: this.vramSel,
      pmode: this.pmode,
      palramLow: Array.from(this.palramLow),
      palramHigh: Array.from(this.palramHigh),
      palramHighNext: this.palramHighNext.slice(),
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
    this.pmode = s.pmode ?? 0;
    if (s.palramLow)
      for (let i = 0; i < 8; i++) this.palramLow[i] = s.palramLow[i] ?? 0;
    if (s.palramHigh)
      for (let i = 0; i < 8; i++) this.palramHigh[i] = s.palramHigh[i] ?? 0;
    if (s.palramHighNext)
      for (let i = 0; i < 8; i++)
        this.palramHighNext[i] = s.palramHighNext[i] ?? false;
  }

  register(bus: IOBus): void {
    bus.register(0x52, {
      name: "display/bgpal",
      write: (_p, v) => {
        this.bgColor = (v & PORT52.BG_MASK) >> PORT52.BG_SHIFT;
        // No renderer yet — the latched value is just kept around
        // for snapshot diagnostics.
        log.warn(`0x52 write: bgColor=${byte(v)} (stub)`);
      },
    });

    bus.register(0x53, {
      name: "display/layer-mask",
      write: (_p, v) => {
        this.showText = (v & PORT53.HIDE_TEXT) === 0;
        this.showGVRAM0 = (v & PORT53.HIDE_GVRAM0) === 0;
        this.showGVRAM1 = (v & PORT53.HIDE_GVRAM1) === 0;
        this.showGVRAM2 = (v & PORT53.HIDE_GVRAM2) === 0;
        this.showGVRAM3 = (v & PORT53.HIDE_GVRAM3) === 0;
        log.warn(
          `0x53 write: text=${this.showText} g0=${this.showGVRAM0} g1=${this.showGVRAM1} g2=${this.showGVRAM2} g3=${this.showGVRAM3} (stub)`,
        );
      },
    });

    for (let i = 0; i < 8; i++) {
      const port = 0x54 + i;
      const idx = i;
      bus.register(port, {
        name: `display/pal${i}`,
        write: (_p, v) => {
          if (this.pmode === 1) {
            // Analogue: alternate between the low (G+R) and high
            // (B + sentinel) halves on each consecutive write to the
            // same port. SR boot writes both halves back-to-back.
            if (this.palramHighNext[idx]) {
              this.palramHigh[idx] = v;
              this.palramHighNext[idx] = false;
              log.info(`pal${idx}H := 0x${byte(v)}`);
            } else {
              this.palramLow[idx] = v;
              this.palramHighNext[idx] = true;
              log.info(`pal${idx}L := 0x${byte(v)}`);
            }
          } else {
            // Digital: single byte (3-bit GRB code in bits 0-2).
            this.palramLow[idx] = v;
            log.info(`pal${idx} := 0x${byte(v)}`);
          }
        },
      });
    }

    // 0x5C-0x5F: GVRAM plane select / main-RAM toggle. The port
    // number's low 2 bits are the selector; the data byte is ignored.
    //
    //   0x5C  →  GVRAM plane 0 mapped at 0xC000-0xEFFF
    //   0x5D  →  GVRAM plane 1
    //   0x5E  →  GVRAM plane 2
    //   0x5F  →  main RAM at 0xC000-0xEFFF (GVRAM hidden)
    //
    // Reads at 0x5C return a one-hot encoding of the active selector
    // (`0xf8 | (1 << sel)` for sel 0..2; `0xf8` for sel 3 since "main
    // RAM" has no plane bit). Per MAME `vram_select_r`.
    for (let i = 0; i < 4; i++) {
      const port = 0x5c + i;
      const sel = i as 0 | 1 | 2 | 3;
      bus.register(port, {
        name: `display/vram-sel${i}`,
        // MAME's vram_select_r is registered only on 0x5C, but
        // mirroring the readback on each port is harmless.
        read: () =>
          this.vramSel === VRAM_SEL.MAIN_RAM
            ? VRAM_SEL.READBACK_BASE
            : VRAM_SEL.READBACK_BASE | (1 << this.vramSel),
        write: (_p, _v) => this.selectVRAM(sel),
      });
    }
  }

  private selectVRAM(sel: 0 | 1 | 2 | 3): void {
    this.vramSel = sel;
    if (sel === VRAM_SEL.MAIN_RAM) {
      // 0x5F: hide GVRAM, expose main RAM at 0xC000-0xEFFF. Plane
      // index is meaningless in this mode but we leave the latched
      // _gvramPlane alone so a follow-up 0x5C/D/E restores the same
      // plane the BIOS was last working with.
      this.memoryMap.setVRAMEnabled(false);
      return;
    }
    this.memoryMap.setGVRAMPlane(sel);
    this.memoryMap.setVRAMEnabled(true);
  }
}
