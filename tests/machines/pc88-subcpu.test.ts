import { describe, expect, it } from "vitest";

import { kOps } from "../../src/flavour.makers.js";
import type { u8 } from "../../src/flavours.js";
import type { PC88Config } from "../../src/machines/config.js";
import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { filledROM } from "../tools.js";

// Sub-CPU ROM: read incoming byte from main side, increment, write
// back, then HALT. Padded out to 2 KB to match the variant
// descriptor size.
function echoPlusOneRom(): Uint8Array {
  const rom = new Uint8Array(2048).fill(0x00);
  rom.set([0xdb, 0xfd, 0x3c, 0xd3, 0xfc, 0x76], 0);
  return rom;
}

function syntheticRoms(program: u8[], opts: { withDisk?: boolean } = {}): LoadedROMs {
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);
  const base = { n80, n88, e0 };
  return opts.withDisk ? { ...base, disk: echoPlusOneRom() } : base;
}

const MKII_LIKE: PC88Config = {
  ...MKI,
  disk: { ...MKI.disk, hasSubCpu: true },
};

describe("PC88Machine + SubCPU wiring", () => {
  it("does not create a SubCPU when hasSubCpu is false", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    expect(machine.subcpu).toBeNull();
    expect(machine.ppi).toBeNull();
  });

  it("does not create a SubCPU if hasSubCpu but disk ROM is missing", () => {
    const machine = new PC88Machine(MKII_LIKE, syntheticRoms([0x00]));
    expect(machine.subcpu).toBeNull();
    expect(machine.ppi).toBeNull();
  });

  it("creates SubCPU + PPI when both conditions are met", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    expect(machine.subcpu).not.toBeNull();
    expect(machine.ppi).not.toBeNull();
  });

  it("PPI is registered on the main IOBus at 0xFC-0xFF", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    expect(machine.ppi).not.toBeNull();
    machine.ioBus.write(0xfc, 0xa5);
    expect(machine.ppi!.hasFreshForSub()).toBe(true);
  });
});

describe("PC88Machine.snapshot with SubCPU", () => {
  it("emits null subcpu/ppi entries on hasSubCpu=false variants", () => {
    const machine = new PC88Machine(MKI, syntheticRoms([0x00]));
    machine.reset();
    const snap = machine.snapshot();
    expect(snap.subcpu).toBeNull();
    expect(snap.ppi).toBeNull();
  });

  it("emits real subcpu/ppi entries on hasSubCpu=true variants", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    machine.reset();
    const snap = machine.snapshot();
    expect(snap.subcpu).not.toBeNull();
    expect(snap.ppi).not.toBeNull();
    expect(snap.subcpu!.cpu.PC).toBe(0);
  });

  it("reset propagates to the sub-CPU", () => {
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x00], { withDisk: true }),
    );
    machine.subcpu!.cpu.regs.PC = 0x1234;
    machine.subcpu!.cpu.cycles = 9999;
    machine.reset();
    expect(machine.subcpu!.cpu.regs.PC).toBe(0);
    expect(machine.subcpu!.cpu.cycles).toBe(0);
  });
});

describe("runMachine schedules both CPUs", () => {
  it("advances sub-CPU cycles alongside main", () => {
    // Main program: tight `JR $` loop so the runner exhausts ops
    // budget. Sub-CPU runs the echo+1 program and HALTs.
    //   0x0000  18 FE         JR $
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x18, 0xfe], { withDisk: true }),
    );
    machine.reset();
    runMachine(machine, { maxOps: kOps(1) });
    expect(machine.subcpu!.cpu.cycles).toBeGreaterThan(0);
    expect(machine.subcpu!.cpu.halted).toBe(true);
  });

  it("runs the full IPC round-trip end-to-end", () => {
    // Main ROM is just a tight JR-self loop so the runner spends its
    // ops budget on the sub-CPU. The PPI is primed via the direct
    // poke API (the BIOS does the same thing through the bus, but
    // the cycle alternation between two CPUs makes the bus-only
    // version race; real silicon resolves the race with PPI status
    // bits + IRQ wakeups, which the FDC will eventually wire up).
    //   0x0000  18 FE        JR $
    const machine = new PC88Machine(
      MKII_LIKE,
      syntheticRoms([0x18, 0xfe], { withDisk: true }),
    );
    machine.reset();
    machine.ppi!.pokeMainOutgoing(0x41);

    runMachine(machine, { maxOps: kOps(1) });

    expect(machine.subcpu!.cpu.halted).toBe(true);
    expect(machine.ioBus.read(0xfd)).toBe(0x42);
    expect(machine.ppi!.hasFreshForMain()).toBe(false);
  });
});
