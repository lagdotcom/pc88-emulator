import { Z80 } from "../../src/chips/z80/cpu.js";
import { MemoryBus, type MemoryProvider } from "../../src/core/MemoryBus.js";

class Ram64K implements MemoryProvider {
  name = "ram";
  start = 0;
  end = 0x10000;
  bytes = new Uint8Array(0x10000);

  read(offset: number): number {
    return this.bytes[offset]!;
  }

  write(offset: number, value: number): void {
    this.bytes[offset] = value;
  }
}

class StubIo implements MemoryProvider {
  name = "io";
  start = 0;
  end = 0x10000;
  reads: [number, number][] = [];
  writes: [number, number][] = [];

  read(port: number): number {
    this.reads.push([port, 0]);
    return 0xff;
  }

  write(port: number, value: number): void {
    this.writes.push([port, value]);
  }
}

export interface ProgramHarness {
  cpu: Z80;
  ram: Ram64K;
  io: StubIo;
}

export function makeProgramHarness(): ProgramHarness {
  const ram = new Ram64K();
  const io = new StubIo();
  const cpu = new Z80(new MemoryBus([ram], 0xff), new MemoryBus([io], 0xff));
  return { cpu, ram, io };
}

export interface RunOptions {
  // Address to load bytes at.
  loadAddr?: number;
  // Initial PC; defaults to loadAddr.
  startPc?: number;
  // Initial SP.
  sp?: number;
  // Hard cap on instructions executed (catches infinite loops in broken
  // tests). Defaults to ten million, which is enough for most small
  // programs but won't accidentally hang vitest forever.
  maxOps?: number;
}

export interface RunResult {
  ops: number;
  cycles: number;
}

// Loads `bytes` and runs until the CPU executes HALT. Returns the number
// of instructions executed and the cumulative t-state count.
export function runUntilHalt(
  h: ProgramHarness,
  bytes: ArrayLike<number>,
  opts: RunOptions = {},
): RunResult {
  const loadAddr = opts.loadAddr ?? 0x0000;
  const startPc = opts.startPc ?? loadAddr;
  const sp = opts.sp ?? 0xffff;
  const max = opts.maxOps ?? 10_000_000;

  const { cpu, ram } = h;
  for (let i = 0; i < bytes.length; i++) {
    ram.bytes[(loadAddr + i) & 0xffff] = bytes[i]!;
  }
  cpu.regs.PC = startPc;
  cpu.regs.SP = sp;
  cpu.cycles = 0;
  cpu.halted = false;
  cpu.prefix = undefined;

  let ops = 0;
  while (!cpu.halted) {
    cpu.runOneOp();
    ops++;
    if (ops >= max) {
      throw new Error(
        `program did not halt after ${max} instructions (PC=${cpu.regs.PC.toString(16)})`,
      );
    }
  }
  return { ops, cycles: cpu.cycles };
}

// CP/M-style BDOS handler. Implements:
//   function 0  - terminate program (warm boot)
//   function 2  - print char in E
//   function 9  - print '$'-terminated string at DE
// Anything else is a no-op. The harness traps any CALL into 0x0005 and
// simulates a RET, so the loaded program runs as if BDOS were resident.
export interface CpmResult {
  output: string;
  ops: number;
  cycles: number;
  exitReason: "bdos-terminate" | "warm-boot" | "halt" | "max-ops";
}

export function runCpm(
  h: ProgramHarness,
  bytes: ArrayLike<number>,
  opts: RunOptions = {},
): CpmResult {
  const loadAddr = opts.loadAddr ?? 0x0100;
  const startPc = opts.startPc ?? loadAddr;
  const sp = opts.sp ?? 0xff00;
  const max = opts.maxOps ?? 200_000_000;

  const { cpu, ram } = h;
  ram.bytes.fill(0);

  // CP/M low-memory layout:
  //   0x0000 = warm-boot vector (some programs JP here to exit)
  //   0x0005 = BDOS entry (we trap this)
  // We seed both with RET (0xc9) so a stray CALL doesn't run garbage.
  ram.bytes[0x0000] = 0xc9;
  ram.bytes[0x0005] = 0xc9;

  for (let i = 0; i < bytes.length; i++) {
    ram.bytes[(loadAddr + i) & 0xffff] = bytes[i]!;
  }
  cpu.regs.PC = startPc;
  cpu.regs.SP = sp;
  cpu.cycles = 0;
  cpu.halted = false;
  cpu.prefix = undefined;

  let output = "";
  let ops = 0;
  let exitReason: CpmResult["exitReason"] = "max-ops";

  while (ops < max) {
    if (cpu.regs.PC === 0x0005) {
      const fn = cpu.regs.C;
      if (fn === 0) {
        exitReason = "bdos-terminate";
        break;
      } else if (fn === 2) {
        output += String.fromCharCode(cpu.regs.E);
      } else if (fn === 9) {
        let addr = cpu.regs.DE;
        // Hard cap on string length so a missing '$' terminator doesn't
        // run away.
        for (let i = 0; i < 0x10000; i++) {
          const b = ram.bytes[addr]!;
          if (b === 0x24) break;
          output += String.fromCharCode(b);
          addr = (addr + 1) & 0xffff;
        }
      }
      // Simulate RET regardless of fn.
      const lo = ram.bytes[cpu.regs.SP]!;
      const hi = ram.bytes[(cpu.regs.SP + 1) & 0xffff]!;
      cpu.regs.PC = (hi << 8) | lo;
      cpu.regs.SP = (cpu.regs.SP + 2) & 0xffff;
      ops++;
      continue;
    }
    if (cpu.regs.PC === 0x0000) {
      exitReason = "warm-boot";
      break;
    }
    if (cpu.halted) {
      exitReason = "halt";
      break;
    }
    cpu.runOneOp();
    ops++;
  }

  return { output, ops, cycles: cpu.cycles, exitReason };
}
