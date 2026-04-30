import { describe, expect, it } from "vitest";

import {
  type LoadedRoms,
  PC88MemoryMap,
} from "../../src/machines/pc88-memory.js";
import { filledROM } from "../tools.testHelpers.js";

function fixture(): LoadedRoms {
  return {
    n80: filledROM(0x8000, 0x80),
    n88: filledROM(0x8000, 0x88),
    e0: filledROM(0x2000, 0xe0),
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

  it("default state at 0x6000 is BASIC ROM continuation, not the E-ROM slot", () => {
    // Reset state must NOT map an E-ROM at 0x6000 — the BIOS init
    // path expects BASIC continuation there until it explicitly
    // enables an E-ROM via port 0x32. Earlier code that mapped
    // slot 0 unconditionally regressed N-BASIC boot.
    const m = new PC88MemoryMap(fixture());
    expect(m.read(0x6000)).toBe(0x80); // BASIC continuation
    expect(m.eromEnabled).toBe(false);
  });

  it("maps the active extension-ROM slot only when enabled", () => {
    const fixtureWithAllE = (): LoadedRoms => ({
      n80: filledROM(0x8000, 0x80),
      n88: filledROM(0x8000, 0x88),
      e0: filledROM(0x2000, 0xe0),
      e1: filledROM(0x2000, 0xe1),
      e2: filledROM(0x2000, 0xe2),
      e3: filledROM(0x2000, 0xe3),
    });
    const m = new PC88MemoryMap(fixtureWithAllE());
    m.setEromEnabled(true);
    expect(m.read(0x6000)).toBe(0xe0); // slot 0 = E0
    m.setEromSlot(1);
    expect(m.read(0x6000)).toBe(0xe1);
    m.setEromSlot(2);
    expect(m.read(0x6000)).toBe(0xe2);
    m.setEromSlot(3);
    expect(m.read(0x6000)).toBe(0xe3);
    expect(m.read(0x5fff)).toBe(0x80); // outside the slot window
    m.setEromEnabled(false);
    expect(m.read(0x6000)).toBe(0x80); // back to BASIC continuation
  });

  it("falls back to BASIC ROM continuation when the active slot has no image", () => {
    // mkI only ships E0; selecting slot 1/2/3 with E-ROMs enabled
    // must still return readable bytes (the BASIC ROM continuation),
    // not throw or return garbage.
    const m = new PC88MemoryMap(fixture());
    m.setEromEnabled(true);
    m.setEromSlot(1);
    expect(m.read(0x6000)).toBe(0x80);
    m.setEromSlot(0);
    expect(m.read(0x6000)).toBe(0xe0);
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
