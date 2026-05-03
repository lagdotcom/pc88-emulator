import { describe, expect, it } from "vitest";

import type { u8 } from "../../src/flavours.js";
import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { MKII_SR } from "../../src/machines/variants/mk2sr.js";
import { filledROM } from "../tools.js";

function syntheticRoms(program: u8[]): LoadedROMs {
  // Drop the program at the start of the n80 image so reset's PC=0
  // jumps straight into it. The other ROMs are filled with HALT so a
  // misrouted fetch is obvious.
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);
  return { n80, n88, e0 };
}

describe("PC88Machine boot path", () => {
  it("writes 'HI' to TVRAM and the display dumps it", () => {
    // TVRAM at 0xF000 is permanently mapped on PC-8801 mkI; no port
    // handshake is needed. PC-88 always uses attribute mode where
    // each visible cell is 2 bytes (char at +0, attr at +1), so 'H'
    // at TVRAM+0 (col 0 char) and 'I' at TVRAM+2 (col 1 char).
    // prettier-ignore
    const program = [
      0x3e, 0x48,             // LD A, 'H'
      0x32, 0x00, 0xf0,       // LD (0xF000), A   — col 0 char
      0x3e, 0x49,             // LD A, 'I'
      0x32, 0x02, 0xf0,       // LD (0xF002), A   — col 1 char
      0x76,                   // HALT
    ];
    const machine = new PC88Machine(MKI, syntheticRoms(program));
    machine.reset();
    runMachine(machine, { maxOps: 200 });

    // rawTvramDump is now a hex+ASCII dump addressed at 0xF000; the
    // first line shows the bytes we wrote, with attribute bytes
    // (which we left as 0x00) rendering as "." in the ASCII column.
    const dump = machine.display.rawTVRAMDump();
    const firstLine = dump.split("\n")[0];
    expect(firstLine).toContain("48 00 49 00");
    expect(firstLine).toContain("H.I.");
  });

  it("halts cleanly when the program HALTs with IFF1=0", () => {
    const program = [0x76];
    const machine = new PC88Machine(MKI, syntheticRoms(program));
    machine.reset();
    const result = runMachine(machine, { maxOps: 100 });
    expect(result.reason).toBe("halted-no-irq");
    expect(machine.cpu.halted).toBe(true);
  });

  it("delivers a SOUND IRQ via the YM2203 timer + IRQ-mask path", () => {
    // SR's BIOS programs IRQ mask = 0x02 (SOUND only) and EIs.
    // Our minimum YM2203 timer fires SOUND IRQ on overflow when the
    // chip's own ENABLE bit is set AND the irq-controller mask
    // permits. This program reproduces the chain end-to-end:
    //   - program YM2203: NA = 0x3FF → period = 1 × 72 cycles
    //   - mode 0x05  → LOAD A + IRQ A (chip enables /IRQ output)
    //   - sysctrl mask = 0x02 → SOUND unmasked at irq controller
    //   - IM 1 + EI; HALT — wake when SOUND IRQ fires; PC = 0x0038.
    // SR is the smallest variant that wires the YM2203 by default.
    // prettier-ignore
    const program = [
      0xf3,                   // DI
      0x3e, 0x24, 0xd3, 0x44, // OUT (0x44), 0x24    — addr = TIMER A high
      0x3e, 0xff, 0xd3, 0x45, // OUT (0x45), 0xff    — TA high = 0xff
      0x3e, 0x25, 0xd3, 0x44, // OUT (0x44), 0x25    — addr = TIMER A low
      0x3e, 0x03, 0xd3, 0x45, // OUT (0x45), 0x03    — TA low = 0x03  (NA = 0x3ff)
      0x3e, 0x27, 0xd3, 0x44, // OUT (0x44), 0x27    — addr = mode reg
      0x3e, 0x05, 0xd3, 0x45, // OUT (0x45), 0x05    — LOAD A + IRQ A
      0x3e, 0x02, 0xd3, 0xe6, // OUT (0xe6), 0x02    — irq-controller SOUND unmask
      0xed, 0x56,             // IM 1                — vector 0x0038 on accept
      0xfb,                   // EI
      0x76,                   // HALT — wait for SOUND IRQ
    ];
    // Use SR variant (no real ROMs) — synthetic ones are fine for a
    // hand-written program; we just need `MKII_SR.sound.psg ===
    // "YM2203"` so PC88Machine wires the chip + IRQ callback.
    const synth: LoadedROMs = {
      n80: filledROM(0x8000, 0x76),
      n88: filledROM(0x8000, 0x76),
      e0: filledROM(0x2000, 0x76),
    };
    for (let i = 0; i < program.length; i++) synth.n88![i] = program[i]!;
    const machine = new PC88Machine(MKII_SR, synth);
    machine.reset();
    machine.memoryMap.setBasicMode("n88");
    // IM 1 vectors to 0x0038 on accept; the synthetic n88 is filled
    // with HALT so the IRQ handler immediately re-HALTs with IFF1=0,
    // and runMachine exits on halted-no-irq.
    const result = runMachine(machine, { maxOps: 1000 });
    expect(machine.opn).not.toBeNull();
    expect(machine.cpu.iff1).toBe(false);
    expect(machine.cpu.halted).toBe(true);
    // After IM 1 vectors to 0x0038 the synthetic HALT there executes
    // and PC advances to 0x0039 ready to re-fetch on the next IRQ.
    expect(result.finalPC).toBe(0x0039);
    expect(result.reason).toBe("halted-no-irq");
  });
});
