import { describe, expect, it } from "vitest";

import type { u8, u16 } from "../../src/flavours.js";
import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { filledROM } from "../tools.js";

function syntheticRoms(program: u8[], opts: { withFont?: boolean } = {}): LoadedROMs {
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);
  const base: LoadedROMs = { n80, n88, e0 };
  if (!opts.withFont) return base;
  // Synthetic 2 KB font ROM: every char gets a "diagonal stripe"
  // glyph (rows 0..7 = 0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02,
  // 0x01) so tests can detect the overlay on any cell.
  const font = new Uint8Array(2048);
  const stripe = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];
  for (let ch = 0; ch < 256; ch++) {
    for (let r = 0; r < 8; r++) font[ch * 8 + r] = stripe[r]!;
  }
  return { ...base, font };
}

// Helper: drop a string into TVRAM at the given absolute address as
// 2-byte cells (char + 0x00 attribute).
function fillTextCells(machine: PC88Machine, addr: u16, s: string): void {
  const tvramOffset = addr - 0xf000;
  for (let i = 0; i < s.length; i++) {
    machine.memoryMap.tvram[tvramOffset + i * 2] = s.charCodeAt(i);
    machine.memoryMap.tvram[tvramOffset + i * 2 + 1] = 0;
  }
}

describe("PC88TextDisplay visible region", () => {
  it("returns a placeholder when the CRTC has not been programmed", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76])); // HALT
    machine.reset();
    runMachine(machine, { maxOps: 10 });
    const dump = machine.display.toASCIIDump();
    expect(dump).toMatch(/CRTC not yet programmed/);
  });

  it("renders the CRTC+DMAC-fetched region when SET MODE has run", () => {
    // Program the machine the way N-BASIC does: 40-col 2-byte-cell
    // mode (port 0x30 bit 0 clear), CRTC SET MODE for an 80-byte
    // cell run × 20 rows, DMAC ch2 source = 0xF300, then drop
    // "HELLO" at the top-left of the visible region.
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();

    // Port 0x30 write with COLS_80 clear → 40-col / 2-byte-cell mode.
    machine.ioBus.write(0x30, 0x00);

    // CRTC SET MODE (cmd 0x00, 5 params: 80×20).
    machine.ioBus.write(0x51, 0x00);
    machine.ioBus.write(0x50, 0xce);
    machine.ioBus.write(0x50, 0x93);
    machine.ioBus.write(0x50, 0x69);
    machine.ioBus.write(0x50, 0xbe);
    machine.ioBus.write(0x50, 0x13);

    // DMAC ch2 source = 0xF300 (low byte then high byte).
    machine.ioBus.write(0x64, 0x00);
    machine.ioBus.write(0x64, 0xf3);

    fillTextCells(machine, 0xf300, "HELLO");

    const dump = machine.display.toASCIIDump();
    const lines = dump.split("\n");
    expect(lines[0]).toBe("HELLO");
    expect(lines).toHaveLength(20);
  });

  it("honours the DMAC source offset when it isn't 0xF000", () => {
    // The first 0x300 bytes of TVRAM are off-screen scratch when
    // DMAC ch2 starts at 0xF300; bytes there must NOT show up in
    // the visible dump. 40-col 2-byte-cell mode for the 2-byte
    // fillTextCells helper to populate cells correctly.
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();
    machine.ioBus.write(0x30, 0x00); // COLS_80 clear → 40-col mode
    machine.ioBus.write(0x51, 0x00);
    machine.ioBus.write(0x50, 0xce);
    machine.ioBus.write(0x50, 0x93);
    machine.ioBus.write(0x50, 0x69);
    machine.ioBus.write(0x50, 0xbe);
    machine.ioBus.write(0x50, 0x13);
    machine.ioBus.write(0x64, 0x00);
    machine.ioBus.write(0x64, 0xf3);

    fillTextCells(machine, 0xf000, "OFFSCREEN");
    fillTextCells(machine, 0xf300, "VISIBLE");

    const dump = machine.display.toASCIIDump();
    expect(dump).not.toMatch(/OFFSCREEN/);
    expect(dump).toMatch(/^VISIBLE/);
  });

  it("rawTvramDump shows the full 4 KB regardless of CRTC state", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();
    fillTextCells(machine, 0xf000, "OFFSCREEN");
    const dump = machine.display.rawTVRAMDump();
    // 4 KB / 16 bytes per line = 256 lines.
    expect(dump.split("\n")).toHaveLength(256);
    // First line should contain the 'O' 'F' 'F' bytes interleaved
    // with 0x00 attributes.
    expect(dump.split("\n")[0]).toContain("4f 00 46 00 46 00");
    expect(dump.split("\n")[0]).toContain("O.F.F.");
  });
});

// Read the RGB triplet at (x, y) from a 640-wide RGBA frame.
function px(rgba: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const i = (y * 640 + x) * 4;
  return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!];
}

describe("PC88TextDisplay.getPixelFrame — GVRAM composite", () => {
  function setup() {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();
    // Make all GVRAM planes visible (PC-88 layer-mask is active-low —
    // a 0 bit in port 0x53 means "show this layer"). Reset leaves
    // showGVRAM* false until the BIOS programs the mask, but the
    // pixel frame should be testable without going through the boot.
    machine.displayRegs.showGVRAM0 = true;
    machine.displayRegs.showGVRAM1 = true;
    machine.displayRegs.showGVRAM2 = true;
    return machine;
  }

  it("returns a 640x200 RGBA frame", () => {
    const machine = setup();
    const frame = machine.display.getPixelFrame()!;
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(200);
    expect(frame.rgba.length).toBe(640 * 200 * 4);
  });

  it("plane 0 alone produces blue pixels (digital index 1)", () => {
    const machine = setup();
    // Set the leftmost 8 pixels of row 0 in plane 0 only.
    machine.memoryMap.gvram[0]![0] = 0xff;
    const { rgba } = machine.display.getPixelFrame()!;
    for (let x = 0; x < 8; x++) {
      expect(px(rgba, x, 0)).toEqual([0x00, 0x00, 0xff]);
    }
    // The next byte over should still be background (black).
    expect(px(rgba, 8, 0)).toEqual([0x00, 0x00, 0x00]);
  });

  it("planes combine with bit 0 = blue, bit 1 = red, bit 2 = green", () => {
    const machine = setup();
    // Same pixel position in all three planes — should give white (7).
    const off = 10 * 80 + 5;
    machine.memoryMap.gvram[0]![off] = 0x80;
    machine.memoryMap.gvram[1]![off] = 0x80;
    machine.memoryMap.gvram[2]![off] = 0x80;
    const { rgba } = machine.display.getPixelFrame()!;
    expect(px(rgba, 5 * 8, 10)).toEqual([0xff, 0xff, 0xff]);
    // Plane 1 + plane 2 only at a different bit (col 1) → magenta? No,
    // plane 1 = red, plane 2 = green → yellow.
    machine.memoryMap.gvram[0]![off] = 0x00;
    machine.memoryMap.gvram[1]![off] = 0x40;
    machine.memoryMap.gvram[2]![off] = 0x40;
    const frame2 = machine.display.getPixelFrame()!;
    expect(px(frame2.rgba, 5 * 8 + 1, 10)).toEqual([0xff, 0xff, 0x00]);
  });

  it("MSB is leftmost pixel of each byte", () => {
    const machine = setup();
    machine.memoryMap.gvram[1]![20] = 0b1000_0001; // bit 7 + bit 0 → cols 0 + 7
    const { rgba } = machine.display.getPixelFrame()!;
    // 20 = byte index in row 0 / col 20 mod 80. y=0, xByte=20 → x=160..167.
    expect(px(rgba, 160, 0)).toEqual([0xff, 0x00, 0x00]); // red (plane 1)
    expect(px(rgba, 161, 0)).toEqual([0x00, 0x00, 0x00]); // bg
    expect(px(rgba, 167, 0)).toEqual([0xff, 0x00, 0x00]);
  });

  it("layer mask hides individual planes", () => {
    const machine = setup();
    machine.memoryMap.gvram[0]![0] = 0xff; // would be blue
    machine.memoryMap.gvram[1]![0] = 0xff; // would add red
    machine.displayRegs.showGVRAM0 = false; // hide plane 0
    const { rgba } = machine.display.getPixelFrame()!;
    // With plane 0 hidden, only red survives.
    expect(px(rgba, 0, 0)).toEqual([0xff, 0x00, 0x00]);
  });

  it("background colour fills pixels where every visible plane bit is 0", () => {
    const machine = setup();
    // bgColor field stores the 0..7 index from port 0x52 bits 4..6.
    machine.displayRegs.bgColor = 5; // cyan
    const { rgba } = machine.display.getPixelFrame()!;
    // Anywhere we haven't written planes is now cyan.
    expect(px(rgba, 100, 50)).toEqual([0x00, 0xff, 0xff]);
    // A foreground pixel still draws its own colour.
    machine.memoryMap.gvram[2]![50 * 80 + 12] = 0x80;
    const { rgba: r2 } = machine.display.getPixelFrame()!;
    expect(px(r2, 12 * 8, 50)).toEqual([0x00, 0xff, 0x00]); // green plane 2
  });
});

describe("PC88TextDisplay.getPixelFrame — text overlay", () => {
  function programCRTC(machine: PC88Machine, mode40Col = false): void {
    machine.ioBus.write(0x30, mode40Col ? 0x00 : 0x01);
    // CRTC SET MODE: 80×20 standard programming.
    machine.ioBus.write(0x51, 0x00);
    machine.ioBus.write(0x50, 0xce);
    machine.ioBus.write(0x50, 0x93);
    machine.ioBus.write(0x50, 0x69);
    machine.ioBus.write(0x50, 0xbe);
    machine.ioBus.write(0x50, 0x13);
    // DMAC ch2 source = 0xF300.
    machine.ioBus.write(0x64, 0x00);
    machine.ioBus.write(0x64, 0xf3);
  }

  it("graphics-only frame when no font ROM is loaded", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76])); // no font
    machine.reset();
    programCRTC(machine);
    machine.memoryMap.tvram[0x300] = 0x41; // 'A' at top-left
    const { rgba } = machine.display.getPixelFrame()!;
    // Without the font ROM, the TVRAM cells don't draw — top-left
    // should still be the bg colour (black at reset).
    expect(px(rgba, 0, 0)).toEqual([0x00, 0x00, 0x00]);
  });

  it("draws glyph pixels white over GVRAM when font ROM is loaded", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76], { withFont: true }));
    machine.reset();
    programCRTC(machine);
    // Drop a non-zero char into the visible region's first cell. The
    // synthetic font's diagonal stripe lights up (0,0), (1,1), …,
    // (7,7) within the 8x10 cell.
    machine.memoryMap.tvram[0x300] = 0x41; // 'A' (any non-zero)
    const { rgba } = machine.display.getPixelFrame()!;
    for (let i = 0; i < 8; i++) {
      expect(px(rgba, i, i)).toEqual([0xff, 0xff, 0xff]);
    }
    // Off-diagonal pixels stay at the bg colour.
    expect(px(rgba, 0, 1)).toEqual([0x00, 0x00, 0x00]);
  });

  it("char 0x00 is skipped (no overlay where TVRAM is empty)", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76], { withFont: true }));
    machine.reset();
    programCRTC(machine);
    // GVRAM plane 1 sets a red pixel at the top-left cell, which
    // would be overwritten if we naively rendered char 0's glyph.
    machine.displayRegs.showGVRAM1 = true;
    machine.memoryMap.gvram[1]![0] = 0x80;
    // TVRAM cells default to 0; overlay must skip them so the
    // graphics layer wins.
    const { rgba } = machine.display.getPixelFrame()!;
    expect(px(rgba, 0, 0)).toEqual([0xff, 0x00, 0x00]);
  });

  it("glyph stretches horizontally in 40-col mode (cell width 16)", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x76], { withFont: true }));
    machine.reset();
    programCRTC(machine, true); // 40-col: 2-byte cells, char at even
    machine.memoryMap.tvram[0x300] = 0x41; // 'A'
    machine.memoryMap.tvram[0x301] = 0x00; // attr byte
    const { rgba } = machine.display.getPixelFrame()!;
    // Glyph row 0 has only bit 7 set → first 2 pixels (stretched
    // from the original 1) should be white, next 2 should be bg.
    expect(px(rgba, 0, 0)).toEqual([0xff, 0xff, 0xff]);
    expect(px(rgba, 1, 0)).toEqual([0xff, 0xff, 0xff]);
    expect(px(rgba, 2, 0)).toEqual([0x00, 0x00, 0x00]);
  });
});

describe("pixelFrameToPPM", () => {
  it("emits a P6 header followed by RGB bytes", async () => {
    const { pixelFrameToPPM } = await import("../../src/machines/pc88-display.js");
    const frame = {
      width: 2,
      height: 1,
      rgba: new Uint8ClampedArray([
        0xff, 0x00, 0x00, 0xff, // red
        0x00, 0xff, 0x00, 0xff, // green
      ]),
    } as const;
    const out = pixelFrameToPPM(frame);
    const headerEnd = out.indexOf(0x0a, out.indexOf(0x0a, out.indexOf(0x0a) + 1) + 1);
    const header = new TextDecoder().decode(out.slice(0, headerEnd + 1));
    expect(header).toBe("P6\n2 1\n255\n");
    // 2x1 = 2 px × 3 bytes = 6 bytes after header.
    expect(Array.from(out.slice(headerEnd + 1))).toEqual(
      [0xff, 0x00, 0x00, 0x00, 0xff, 0x00],
    );
  });

  it("encodes a full 640x200 frame at the expected byte length", async () => {
    const { pixelFrameToPPM } = await import("../../src/machines/pc88-display.js");
    const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
    machine.reset();
    machine.displayRegs.showGVRAM0 = true;
    const frame = machine.display.getPixelFrame()!;
    const ppm = pixelFrameToPPM(frame);
    // "P6\n640 200\n255\n" = 15 bytes header + 640*200*3 RGB.
    expect(ppm.length).toBe(15 + 640 * 200 * 3);
  });
});
