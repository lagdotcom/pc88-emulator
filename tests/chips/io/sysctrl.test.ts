import { describe, expect, it } from "vitest";

import { Beeper } from "../../../src/chips/io/beeper.js";
import { SystemController } from "../../../src/chips/io/sysctrl.js";
import { IOBus } from "../../../src/core/IOBus.js";
import type { u8 } from "../../../src/flavours.js";
import { PC88MemoryMap } from "../../../src/machines/pc88-memory.js";
import { filledROM } from "../../tools.js";

function setup(dipPort30: u8 = 0xab, dipPort31: u8 = 0xcd) {
  const memoryMap = new PC88MemoryMap({
    n80: filledROM(0x8000, 0x80),
    n88: filledROM(0x8000, 0x88),
    e0: filledROM(0x2000, 0xe0),
  });
  const beeper = new Beeper();
  const bus = new IOBus();
  const sysctrl = new SystemController(memoryMap, beeper, {
    port30: dipPort30,
    port31: dipPort31,
  });
  sysctrl.register(bus);
  return { bus, sysctrl, memoryMap, beeper };
}

describe("SystemController DIP wiring", () => {
  it("exposes the configured DIP bytes at port 0x30 / 0x31", () => {
    const { bus } = setup(0xab, 0xcd);
    expect(bus.read(0x30)).toBe(0xab);
    expect(bus.read(0x31)).toBe(0xcd);
  });

  it("does not hardcode DIP defaults — different configs yield different reads", () => {
    const a = setup(0x12, 0x34);
    const b = setup(0x55, 0x66);
    expect(a.bus.read(0x30)).toBe(0x12);
    expect(b.bus.read(0x30)).toBe(0x55);
    expect(a.bus.read(0x31)).toBe(0x34);
    expect(b.bus.read(0x31)).toBe(0x66);
  });
});

describe("SystemController EROM banking", () => {
  // EROM mapping requires three things on real hardware:
  //   - port 0x32 bits 0-1   select which slot is "current"
  //   - port 0x71 bits 0-3   one-hot active-low; the selected bit
  //                          enables that slot for mapping
  //   - port 0x31 RMODE=0 + MMODE=0 (bits 2 and 1)
  //                          gate enable; if either is non-zero,
  //                          EROM stays unmapped regardless of
  //                          ports 0x32 / 0x71 state
  // The setup() fixture loads only E0, so slot 1/2/3 falls back to
  // BASIC ROM continuation (0x80) even when "enabled".

  it("port 0x71 alone enables EROM with port 0x32 selecting the slot", () => {
    const { bus, memoryMap } = setup();
    // Default (port 0x71 not yet written, eromSelection=0xff) →
    // EROM disabled even with eromsl=0.
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    // Enable slot 0 via port 0x71.
    bus.write(0x71, 0xfe);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    // Switch slot via port 0x32 — slot 1 missing → BASIC continuation.
    bus.write(0x32, 0x01);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x32, 0x02);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x32, 0x03);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    // Back to slot 0.
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    // Disable all slots via port 0x71 → EROM unmapped.
    bus.write(0x71, 0xff);
    expect(memoryMap.read(0x6000)).toBe(0x80);
  });

  it("port 0x31 RMODE=1 (N80 selected) disables EROM mapping", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x71, 0xfe); // enable slot 0
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x31, 0x04); // RMODE = 1
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x31, 0x00); // RMODE = 0
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });

  it("port 0x31 MMODE=1 (RAM at 0x0000-0x7FFF) disables EROM mapping", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x71, 0xfe);
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x31, 0x02); // MMODE = 1
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x31, 0x00); // MMODE = 0
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });
});

describe("SystemController port 0x40 (status / beeper)", () => {
  it("VBL bit on port 0x40 read tracks setVBlank", () => {
    const { bus, sysctrl } = setup();
    sysctrl.setVBlank(true);
    expect(bus.read(0x40) & 0x20).toBe(0x20);
    sysctrl.setVBlank(false);
    expect(bus.read(0x40) & 0x20).toBe(0x00);
  });

  it("bit 5 of port 0x40 writes drives the beeper", () => {
    const { bus, beeper } = setup();
    expect(beeper.toggles).toBe(0);
    bus.write(0x40, 0x20); // beep bit set
    bus.write(0x40, 0x00); // beep bit clear
    bus.write(0x40, 0x20); // beep bit set
    expect(beeper.toggles).toBeGreaterThanOrEqual(2);
  });
});
