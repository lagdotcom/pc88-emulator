import { describe, expect, it } from "vitest";

import { PC88Machine, runMachine } from "../../src/machines/pc88.js";
import type { LoadedRoms } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";

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
    // TVRAM at 0xF000 is permanently mapped on PC-8801 mkI; no port
    // handshake is needed. Cells are 2 bytes each (char + attr), so
    // 'H' goes at +0 and 'I' at +2.
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

    // toAsciiDump renders only what the CRTC+DMAC are configured to
    // display; this test never programs them, so use the raw dump.
    const dump = machine.display.rawTvramDump();
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
