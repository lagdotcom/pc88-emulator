import { describe, expect, it } from "vitest";

import { Beeper } from "../../../src/chips/io/beeper.js";
import { SystemController } from "../../../src/chips/io/sysctrl.js";
import { IOBus } from "../../../src/core/IOBus.js";
import type { u8 } from "../../../src/flavours.js";
import { PC88MemoryMap } from "../../../src/machines/pc88-memory.js";
import { filledROM } from "../../tools.testHelpers.js";

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

describe("SystemController ROM banking via port 0x32", () => {
  it("eromsl=0 enables E0 ROM at 0x6000", () => {
    const { bus, memoryMap } = setup();
    // BASIC ROM continuation by default.
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x32, 0x00); // eromsl bits = 0
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });

  it("eromsl != 0 disables the E0 window (falls back to BASIC ROM continuation)", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x32, 0x01);
    expect(memoryMap.read(0x6000)).toBe(0x80);
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
