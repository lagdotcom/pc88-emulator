// Real-ROM integration test. Skipped unless PC88_REAL_ROMS=1 (and
// the ROMs are actually present in PC88_ROM_DIR / `roms/`). Runs
// the full mkI N-BASIC boot path against the BIOS ROM and asserts
// the visible screen contains the banner. Locks in everything we've
// fixed during first-light:
//   - DIP-driven cold-boot BASIC selection
//   - IM 2 vector dispatch through I:0x00
//   - μPD3301 port 0x50/0x51 routing + top-3-bit command decode
//   - 80x20 attribute-mode TVRAM layout (chars at even, attrs at odd)
//   - DMAC channel-2 source as the visible-region offset
//   - E-ROM disabled at reset (BIOS enables when ready)

import { describe, expect, it } from "vitest";

import { runMachine, PC88Machine } from "../../src/machines/pc88.js";
import type { LoadedRoms } from "../../src/machines/pc88-memory.js";
import { loadRoms } from "../../src/machines/rom-loader.js";
import { MKI } from "../../src/machines/variants/mk1.js";

const REAL = process.env.PC88_REAL_ROMS === "1";
const ROM_DIR = process.env.PC88_ROM_DIR ?? "roms";

describe.runIf(REAL)("PC-8801 mkI N-BASIC boot (real ROMs)", () => {
  it("reaches the BASIC banner in the visible screen at 150k ops", async () => {
    const loaded = await loadRoms(MKI, { dir: ROM_DIR });
    if (!loaded.n80 || !loaded.n88) {
      throw new Error(
        `mkI requires n80 and n88 ROMs in ${ROM_DIR}/ (got ${Object.keys(loaded).join(", ")})`,
      );
    }
    const machine = new PC88Machine(MKI, loaded as LoadedRoms);
    machine.reset();
    runMachine(machine, { maxOps: 150_000 });

    // CRTC programmed, DMAC ch2 pointed at the screen, display on.
    expect(machine.crtc.charsPerRow).toBe(80);
    expect(machine.crtc.rowsPerScreen).toBe(20);
    expect(machine.crtc.displayOn).toBe(true);
    expect(machine.dmac.channelAddress(2)).toBe(0xf300);
    expect(machine.dmac.channelByteCount(2)).toBe(2400);

    // The banner the ROM lays into TVRAM. toAsciiDump renders just
    // the visible region, so each of these strings must appear in
    // the rendered grid.
    const dump = machine.display.toAsciiDump();
    expect(dump).toContain("NEC PC-8001 BASIC Ver 1.2");
    expect(dump).toContain("Copyright 1979 (C) by Microsoft");
    expect(dump).toContain("Ok");
  });

  it("--basic=n88 path: BIOS programs CRTC + DMAC then waits on sub-CPU", async () => {
    // Locks in the current "N88 boots far enough to set up the
    // screen but stalls without a sub-CPU PPI" finding. When sub-CPU
    // emulation lands, this assertion will need to be tightened to
    // require the actual N88 banner.
    const loaded = await loadRoms(MKI, { dir: ROM_DIR });
    if (!loaded.n80 || !loaded.n88) return;
    const config = {
      ...MKI,
      dipSwitches: { ...MKI.dipSwitches, port31: MKI.dipSwitches.port31 & ~0x04 },
    };
    const machine = new PC88Machine(config, loaded as LoadedRoms);
    machine.reset();
    runMachine(machine, { maxOps: 150_000 });

    expect(machine.memoryMap.basicMode).toBe("n88");
    expect(machine.crtc.charsPerRow).toBe(80);
    expect(machine.crtc.displayOn).toBe(true);
    // N88 explicitly programs the IRQ mask (N-BASIC leaves it at
    // factory default 0xff). Capturing this so we notice if the
    // boot path changes.
    expect(machine.irq.programmed).toBe(true);
  });
});
