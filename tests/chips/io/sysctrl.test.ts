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

  it("port 0x31 MMODE=1 unmaps the BASIC ROM at 0x0000-0x5FFF too", () => {
    // Disk-boot transfer step: BIOS loads the boot sector, copies it
    // into main RAM at 0x0000-…, then writes MMODE=1 to unmap the
    // ROM and lets the boot sector code run from RAM. Without the
    // ROM unmap, executing JP 0 would just re-enter the BIOS reset
    // vector instead of the loaded code.
    const { bus, memoryMap } = setup();
    const romByte = memoryMap.read(0x0100);
    // Stash a known byte in main RAM at the same address — write-
    // through shadowing means writes always reach RAM regardless of
    // the ROM map state.
    memoryMap.write(0x0100, 0x42);
    expect(memoryMap.read(0x0100)).toBe(romByte); // ROM still wins.
    bus.write(0x31, 0x02); // MMODE = 1
    expect(memoryMap.read(0x0100)).toBe(0x42); // RAM exposed.
    bus.write(0x31, 0x00); // MMODE = 0
    expect(memoryMap.read(0x0100)).toBe(romByte); // ROM back.
  });

  it("port 0x31 MMODE=1 unmaps BASIC ROM (RAM at 0x0000-0x7FFF) — disables EROM as a side effect", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x71, 0xfe);
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x31, 0x02); // MMODE = 1: BASIC ROM unmapped, RAM exposed.
    // 0x6000 now reads main RAM (zeroed by reset) — the disk-boot
    // path writes its loaded boot code into RAM here before flipping
    // MMODE=1, so this is the path the BIOS takes to hand off
    // execution to a disk-loaded program.
    expect(memoryMap.read(0x6000)).toBe(0x00);
    bus.write(0x31, 0x00); // MMODE = 0: BASIC ROM + EROM both back.
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });

  // The following four cases lock in the MAME-validated semantics
  // (per pc8801.cpp `mem_r`):
  //
  //   if (offset >= 0x6000 && offset <= 0x7fff
  //       && ((m_ext_rom_bank & 1) == 0))
  //     return n88basic_rom_r(0x8000 + (offset & 0x1fff)
  //                           + (0x2000 * (m_misc_ctrl & 3)));
  //
  // i.e. port 0x71 bit 0 alone gates enable; bits 1-3 are
  // documented as TODO ("selection for EXP slot ROMs?") in MAME
  // and DO NOT pick the slot. The active slot index comes from
  // port 0x32 bits 0-1.

  it("port 0x71 bit 0 alone gates E-ROM enable (MAME-validated)", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x32, 0x00); // slot 0
    // bit 0 = 0 → enabled
    bus.write(0x71, 0xfe);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    // bit 0 = 1, bit 1 = 0 → DISABLED per MAME (older emulators
    // treat as "slot 1 enabled" but real silicon does not).
    bus.write(0x71, 0xfd);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    // bit 0 = 1, bits 1-3 = 0 → DISABLED.
    bus.write(0x71, 0xf1);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    // bit 0 = 0 only → enabled.
    bus.write(0x71, 0xfe);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    // bit 0 = 0 with all other low bits also 0 → enabled (bits 1-3
    // shouldn't toggle the gate either way).
    bus.write(0x71, 0xf0);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });

  it("slot index comes from port 0x32 bits 0-1, not port 0x71", () => {
    const { bus, memoryMap } = setup();
    // Enable E-ROM (bit 0 of 0x71 = 0).
    bus.write(0x71, 0xfe);
    // Slot 0 — sr-e0 byte 0xE0 is the only loaded slot in the
    // fixture; slots 1-3 fall through to BASIC ROM continuation.
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    // Selecting slot 1-3 via port 0x32 → BASIC continuation byte.
    // Crucially, port 0x71 hasn't changed; the slot is purely from
    // port 0x32, NOT from "which port-71 bit is clear".
    bus.write(0x32, 0x01);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x32, 0x02);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    bus.write(0x32, 0x03);
    expect(memoryMap.read(0x6000)).toBe(0x80);
    // Slot 0 again.
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });

  it("port 0x71 bits 1-3 set or clear don't affect slot selection", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x32, 0x00); // slot 0 selected
    // Try several port-71 values that all have bit 0 = 0 but
    // various bits 1-3 patterns. All should map slot 0 (= 0xE0).
    bus.write(0x71, 0xfe); // 1111 1110
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x71, 0xfc); // 1111 1100
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x71, 0xf8); // 1111 1000
    expect(memoryMap.read(0x6000)).toBe(0xe0);
    bus.write(0x71, 0xf0); // 1111 0000
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });

  it("MMODE / RMODE gates take precedence over the port-71 bit-0 enable", () => {
    const { bus, memoryMap } = setup();
    bus.write(0x71, 0xfe);
    bus.write(0x32, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0); // baseline: slot 0 mapped

    // RMODE = 1 (N-BASIC) → 0x6000 reads N80 ROM byte 0x80, not
    // E-ROM, even with port-71 bit 0 = 0.
    bus.write(0x31, 0x04);
    expect(memoryMap.read(0x6000)).toBe(0x80);

    // RMODE back to 0; MMODE = 1 (RAM) → 0x6000 reads main RAM
    // (zero-init), not E-ROM.
    bus.write(0x31, 0x02);
    expect(memoryMap.read(0x6000)).toBe(0x00);

    // Both clear → E-ROM mapped.
    bus.write(0x31, 0x00);
    expect(memoryMap.read(0x6000)).toBe(0xe0);
  });
});

describe("SystemController PMODE callback (port 0x32 bit 5)", () => {
  it("fires onPModeChange only on rising / falling edges, not on every write", () => {
    const { bus, sysctrl } = setup();
    const events: (0 | 1)[] = [];
    sysctrl.onPModeChange = (p) => events.push(p);

    // First write with PMODE=0 → no event (already at default 0).
    bus.write(0x32, 0x00);
    expect(events).toEqual([]);

    // PMODE=1: rising edge.
    bus.write(0x32, 0x20);
    expect(events).toEqual([1]);

    // Same PMODE again with other bits noisy: no event.
    bus.write(0x32, 0xa8); // PMODE=1, bits 3+5+7 set
    expect(events).toEqual([1]);

    // Falling edge.
    bus.write(0x32, 0x00);
    expect(events).toEqual([1, 0]);
  });

  it("missing listener (null) doesn't crash on PMODE changes", () => {
    const { bus, sysctrl } = setup();
    sysctrl.onPModeChange = null;
    expect(() => {
      bus.write(0x32, 0x20);
      bus.write(0x32, 0x00);
    }).not.toThrow();
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
