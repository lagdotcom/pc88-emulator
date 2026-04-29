import { describe, expect, it } from "vitest";

import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import type { LoadedRoms } from "../../src/machines/pc88-memory.js";

function syntheticRoms(program: number[]): LoadedRoms {
  // Drop the program at the start of the n80 image so reset's PC=0
  // jumps straight into it. The other ROMs are filled with HALT so a
  // misrouted fetch is obvious.
  const n80 = new Uint8Array(0x8000);
  n80.fill(0x76); // HALT
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = new Uint8Array(0x8000);
  n88.fill(0x76);
  const e0 = new Uint8Array(0x2000);
  e0.fill(0x76);
  return { n80, n88, e0 };
}

describe("PC88Machine boot path", () => {
  it("writes 'HI' to TVRAM and the display dumps it", () => {
    // LD A,'H'    ; 3E 48
    // OUT (0x32),A; D3 32   — enable TVRAM window (bit 4)
    // LD A,0x10   ; 3E 10
    // OUT (0x32),A; D3 10
    // LD A,'H'    ; 3E 48
    // LD (0xF000),A; 32 00 F0
    // LD A,'I'    ; 3E 49
    // LD (0xF001),A; 32 01 F0
    // HALT        ; 76
    // prettier-ignore
    const program = [
      0x3e, 0x10,             // LD A, 0x10
      0xd3, 0x32,             // OUT (0x32), A — TVRAM window on
      0x3e, 0x48,             // LD A, 'H'
      0x32, 0x00, 0xf0,       // LD (0xF000), A
      0x3e, 0x49,             // LD A, 'I'
      0x32, 0x01, 0xf0,       // LD (0xF001), A
      0x76,                   // HALT
    ];
    const machine = new PC88Machine(MKI, syntheticRoms(program));
    machine.reset();
    runMachine(machine, { maxOps: 200 });

    const dump = machine.display.toAsciiDump();
    expect(dump.split("\n")[0]).toBe("HI");
  });

  it("halts cleanly when the program HALTs with IFF1=0", () => {
    const program = [0x76];
    const machine = new PC88Machine(MKI, syntheticRoms(program));
    machine.reset();
    const result = runMachine(machine, { maxOps: 100 });
    expect(result.reason).toBe("halted-no-irq");
    expect(machine.cpu.halted).toBe(true);
  });
});
