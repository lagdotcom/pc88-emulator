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
    const dump = machine.display.rawTvramDump();
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
});
