// Tight-loop benchmark for the Z80 dispatcher. Runs three small programs
// targeting different code paths and reports Mops/s for each. Use to
// measure the impact of dispatcher / regs / memory-bus changes:
//
//   tsx tests/programs/bench.ts

import { Z80 } from "../../src/chips/z80/cpu.js";
import { IOBus } from "../../src/core/IOBus.js";
import { MemoryBus } from "../../src/core/MemoryBus.js";
import type { u8 } from "../../src/flavours.js";
import { RAM64k } from "../tools.testHelpers.js";

interface Bench {
  name: string;
  program: u8[];
  iterations: number; // how many ops per program completion
}

// Tight loop: NOP NOP NOP ... HALT, with the loop counter set up via DJNZ.
// The middle NOP run dominates execution; runtime per outer iteration
// is dominated by the inner DJNZ + NOPs.
function nopLoop(loops: number): Bench {
  // LD B,N
  // loop: NOP × 16
  //       DJNZ loop
  // HALT
  const innerNops = 16;
  const program: number[] = [];
  program.push(0x06, loops & 0xff); // LD B,N
  const loopStart = program.length;
  for (let i = 0; i < innerNops; i++) program.push(0x00); // NOP
  // DJNZ -(distance)
  const distance = -(program.length + 2 - loopStart) & 0xff;
  program.push(0x10, distance);
  program.push(0x76); // HALT
  return {
    name: `NOP×${innerNops} loop, B=${loops}`,
    program,
    iterations: loops * (innerNops + 1) + 2,
  };
}

// Tight register/arithmetic loop: ADD/INC/JR — exercises the same
// instructions zexdoc hammers on.
function addLoop(loops: number): Bench {
  // LD HL,0
  // LD DE,1
  // LD B,N
  // loop: ADD HL,DE
  //       INC DE
  //       DJNZ loop
  // HALT
  // prettier-ignore — keep the byte array dense (one Z80 instruction
  // per source line) so the embedded program reads as assembly.
  // prettier-ignore
  const program = [
      0x21, 0x00, 0x00,    // LD HL,0
      0x11, 0x01, 0x00,    // LD DE,1
      0x06, loops & 0xff,  // LD B,N
      0x19,                // ADD HL,DE
      0x13,                // INC DE
      0x10, 0xfc,          // DJNZ -4
      0x76,                // HALT
  ];
  return {
    name: `ADD HL,DE loop, B=${loops}`,
    program,
    iterations: 3 + loops * 3 + 1,
  };
}

// LDIR — exercises memory R-M-W and the looping ED prefix.
function ldirLoop(bytes: number): Bench {
  // LD HL,0x0200
  // LD DE,0x0400
  // LD BC,N
  // LDIR
  // HALT
  return {
    name: `LDIR ${bytes} bytes`,
    // prettier-ignore
    program: [
      0x21, 0x00, 0x02,                        // LD HL,0x0200
      0x11, 0x00, 0x04,                        // LD DE,0x0400
      0x01, bytes & 0xff, (bytes >> 8) & 0xff, // LD BC,N
      0xed, 0xb0,                              // LDIR
      0x76,                                    // HALT
    ],
    // Each LDIR iteration is 2 dispatches (ED + B0). Setup is 3 LDs.
    iterations: 4 + bytes * 2 + 1,
  };
}

function run(bench: Bench, repeats: number): { mops: number; ms: number } {
  const ram = new RAM64k();
  for (let i = 0; i < bench.program.length; i++)
    ram.bytes[0x0100 + i] = bench.program[i]!;

  // Plant some recognisable bytes at the LDIR source.
  for (let i = 0; i < 0x100; i++) ram.bytes[0x0200 + i] = i & 0xff;
  const cpu = new Z80(new MemoryBus([ram], 0xff), new IOBus());
  if (process.env.DISPATCH === "table") cpu.useDispatchBase = false;

  // Warmup
  for (let r = 0; r < Math.min(3, repeats); r++) {
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.halted = false;
    cpu.prefix = undefined;
    let ops = 0;
    while (!cpu.halted) {
      cpu.runOneOp();
      ops++;
      if (ops > 50_000_000) throw new Error(`runaway in ${bench.name}`);
    }
  }

  // Measured run
  const start = Date.now();
  let ops = 0;
  for (let r = 0; r < repeats; r++) {
    cpu.regs.PC = 0x0100;
    cpu.regs.SP = 0xff00;
    cpu.halted = false;
    cpu.prefix = undefined;
    while (!cpu.halted) {
      cpu.runOneOp();
      ops++;
    }
  }
  const ms = Date.now() - start;
  const mops = ops / 1_000_000 / (ms / 1000);
  return { mops, ms };
}

function main() {
  const benches: { bench: Bench; repeats: number }[] = [
    { bench: nopLoop(255), repeats: 2000 },
    { bench: addLoop(255), repeats: 2000 },
    { bench: ldirLoop(0x100), repeats: 1000 },
  ];

  console.log(
    `${"benchmark".padEnd(40)} ${"ms".padStart(8)} ${"Mops/s".padStart(10)}`,
  );
  console.log("-".repeat(60));
  for (const { bench, repeats } of benches) {
    const { mops, ms } = run(bench, repeats);
    console.log(
      `${bench.name.padEnd(40)} ${ms.toString().padStart(8)} ${mops.toFixed(2).padStart(10)}`,
    );
  }
}

main();
