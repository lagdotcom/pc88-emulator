import { config as loadDotEnv } from "dotenv";
import startNodeLogging from "log-node";

import { Z80 } from "./chips/z80/cpu.js";
import { opCodes } from "./chips/z80/ops.js";
import { MemoryBus, type MemoryProvider } from "./core/MemoryBus.js";

export function showOpTable() {
  for (const op of Object.values(opCodes)) {
    const cycles = op.mCycles.map((m) => m.tStates).reduce((a, b) => a + b);

    console.log(
      `${op.code.toString(16).padStart(2, "0")} ${cycles} ${op.mnemonic}`,
    );
  }
}

class TestProgram implements MemoryProvider {
  memory: Uint8Array;
  start: number;
  end: number;

  constructor(
    public name: string,
    bytes: number[],
  ) {
    this.memory = new Uint8Array(bytes);
    this.start = 0;
    this.end = this.memory.length;
  }

  read(offset: number) {
    return this.memory[offset] ?? 0xfe;
  }

  write(offset: number, value: number) {
    this.memory[offset] = value;
  }
}

function showCpu(cpu: Z80) {
  const regs = (["AF", "BC", "DE", "HL", "IX", "IY", "SP", "PC"] as const)
    .map((pair) => `${pair}:${cpu.regs[pair].toString(16).padStart(4, "0")}`)
    .join(" ");

  console.log(`${regs} cycles:${cpu.cycles}`);
}

function cpuTest() {
  loadDotEnv({ quiet: true });
  startNodeLogging();

  const mem = new MemoryBus([
    new TestProgram(
      "TestProg",
      [
        0x3e, 0x23, 0x47, 0x31, 0x30, 0x00, 0xcd, 0x0b, 0x00, 0x18, 0xfb, 0x21,
        0x10, 0x00, 0x34, 0xc9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ],
    ),
  ]);
  const io = new MemoryBus();
  const cpu = new Z80(mem, io);

  for (let i = 0; i < 10; i++) {
    showCpu(cpu);
    cpu.cycles = 0;
    cpu.runOneOp();
  }

  showCpu(cpu);
}

cpuTest();
