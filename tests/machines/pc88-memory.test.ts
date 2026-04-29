import { describe, expect, it } from "vitest";

import {
  type LoadedRoms,
  PC88MemoryMap,
} from "../../src/machines/pc88-memory.js";

function makeRom(size: number, fill: number): Uint8Array {
  const u = new Uint8Array(size);
  u.fill(fill);
  return u;
}

function fixture(): LoadedRoms {
  return {
    n80: makeRom(0x8000, 0x80),
    n88: makeRom(0x8000, 0x88),
    e0: makeRom(0x2000, 0xe0),
  };
}

describe("PC88MemoryMap", () => {
  it("reads the active BASIC ROM at 0x0000", () => {
    const m = new PC88MemoryMap(fixture());
    m.setBasicMode("n80");
    expect(m.read(0x0000)).toBe(0x80);
    expect(m.read(0x4000)).toBe(0x80);
    m.setBasicMode("n88");
    expect(m.read(0x0000)).toBe(0x88);
    expect(m.read(0x4000)).toBe(0x88);
  });

  it("falls back to RAM when the BASIC ROM is disabled", () => {
    const m = new PC88MemoryMap(fixture());
    m.mainRam[0x0000] = 0x42;
    m.setBasicRomEnabled(false);
    expect(m.read(0x0000)).toBe(0x42);
    m.setBasicRomEnabled(true);
    expect(m.read(0x0000)).toBe(0x80);
  });

  it("swaps E0 ROM in over the upper half of BASIC ROM", () => {
    const m = new PC88MemoryMap(fixture());
    expect(m.read(0x6000)).toBe(0x80); // BASIC ROM continuation
    m.setE0RomEnabled(true);
    expect(m.read(0x6000)).toBe(0xe0);
    expect(m.read(0x5fff)).toBe(0x80); // outside the E0 window
  });

  it("maps TVRAM permanently at 0xF000 (no bank toggle)", () => {
    // PC-8801 mkI has no bank-switch for the 0xF000-0xFFFF page —
    // CPU reads/writes always hit TVRAM. The CRTC controls whether
    // the contents are displayed, not whether they're addressable.
    const m = new PC88MemoryMap(fixture());
    m.tvram[0x0000] = 0x48; // 'H'
    expect(m.read(0xf000)).toBe(0x48);
    m.write(0xf001, 0x49); // write should land in TVRAM
    expect(m.tvram[0x0001]).toBe(0x49);
    expect(m.read(0xf001)).toBe(0x49);
  });

  it("writes to RAM under 0x8000-0xBFFF go to mainRam regardless of bank state", () => {
    const m = new PC88MemoryMap(fixture());
    m.write(0x9000, 0x55);
    expect(m.mainRam[0x9000]).toBe(0x55);
    expect(m.read(0x9000)).toBe(0x55);
  });

  it("writes to ROM-mapped pages are dropped", () => {
    const m = new PC88MemoryMap(fixture());
    m.write(0x0000, 0x99);
    expect(m.read(0x0000)).toBe(0x80); // ROM still there
  });
});
