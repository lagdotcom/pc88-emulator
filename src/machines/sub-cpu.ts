import type { μPD765a } from "../chips/io/μPD765a.js";
import type { μPD8255 } from "../chips/io/μPD8255.js";
import {
  resetZ80,
  restoreZ80,
  snapshotZ80,
  Z80,
  type Z80CPUSnapshot,
} from "../chips/z80/cpu.js";
import { IOBus } from "../core/IOBus.js";
import { MemoryBus, type MemoryProvider } from "../core/MemoryBus.js";
import type { Cycles, Operations, u8 } from "../flavours.js";
import { getLogger } from "../log.js";
import { byte } from "../tools.js";

const log = getLogger("subcpu");

// PC-88 mkII+ FDC sub-CPU. Per MAME's pc80s31k:
//
//   memory:
//     0x0000-0x1FFF  ROM (mirrors within the region; physical chip
//                    is typically 2 KB)
//     0x4000-0x7FFF  RAM (16 KB)
//     anything else  open bus
//
//   I/O ports:
//     0xF0           IRQ vector latch (write-only)
//     0xF4           drive-mode register (write-only)
//     0xFA-0xFB      μPD765 FDC (TODO — chip not built yet)
//     0xFC-0xFF      μPD8255 PPI (sub side; shared with main bus)
//
// The PPI is shared with the main CPU's I/O bus and bridges the two
// sides; see src/chips/io/μPD8255.ts. SubCPU exposes its own MemoryBus
// + IOBus so the FDC + drives can register against them when they
// land, never touching the main CPU's bus.

const ROM_BASE = 0x0000;
const ROM_REGION_END = 0x2000;
const RAM_BASE = 0x4000;
const RAM_SIZE = 0x4000;
const RAM_END = RAM_BASE + RAM_SIZE;

const PORT_IRQ_VECTOR = 0xf0;
const PORT_DRIVE_MODE = 0xf4;

export interface SubCPUSnapshot {
  readonly cpu: Z80CPUSnapshot;
  readonly irqVector: u8;
  readonly driveMode: u8;
}

export class SubCPU {
  readonly cpu: Z80;
  readonly memBus: MemoryBus;
  readonly ioBus: IOBus;
  readonly ppi: μPD8255;
  readonly fdc: μPD765a | null;
  readonly rom: Uint8Array;
  readonly ram: Uint8Array;

  irqVector: u8 = 0;
  driveMode: u8 = 0;

  constructor(opts: { rom: Uint8Array; ppi: μPD8255; fdc?: μPD765a }) {
    this.rom = opts.rom;
    this.ram = new Uint8Array(RAM_SIZE);
    this.ppi = opts.ppi;
    this.fdc = opts.fdc ?? null;

    const romProvider: MemoryProvider = {
      name: "subcpu/rom",
      start: ROM_BASE,
      end: ROM_REGION_END,
      read: (offset) => this.rom[offset % this.rom.length]!,
    };
    const ramProvider: MemoryProvider = {
      name: "subcpu/ram",
      start: RAM_BASE,
      end: RAM_END,
      bytes: this.ram,
      read: (offset) => this.ram[offset]!,
      write: (offset, value) => {
        this.ram[offset] = value;
      },
    };

    this.memBus = new MemoryBus([romProvider, ramProvider]);
    this.ioBus = new IOBus();

    this.ppi.registerSub(this.ioBus);
    this.ioBus.register(PORT_IRQ_VECTOR, {
      name: "subcpu/irq-vec",
      write: (_p, value) => {
        this.irqVector = value;
        log.info(`IRQ vector latched=0x${byte(value)}`);
      },
    });
    this.ioBus.register(PORT_DRIVE_MODE, {
      name: "subcpu/drive-mode",
      write: (_p, value) => {
        this.driveMode = value;
        log.info(`drive mode=0x${byte(value)}`);
      },
    });

    this.cpu = new Z80(this.memBus, this.ioBus);

    // PPI fresh-data wake: a main-side write of port A raises the
    // sub's IRQ line so a HALTed sub-CPU resumes and reads the byte.
    // The vector byte is whatever the sub last latched at port 0xF0
    // (real hardware loops it back through the IRQ controller).
    this.ppi.onFreshForSub = () => {
      this.cpu.requestIrq(this.irqVector);
    };

    if (this.fdc) {
      this.fdc.register(this.ioBus);
      this.fdc.onInterrupt = () => {
        this.cpu.requestIrq(this.irqVector);
      };
    }
  }

  reset(): void {
    resetZ80(this.cpu);
    this.ram.fill(0);
    this.irqVector = 0;
    this.driveMode = 0;
  }

  step(): void {
    this.cpu.runOneOp();
    while (this.cpu.prefix !== undefined) this.cpu.runOneOp();
  }

  runOps(n: Operations): Operations {
    let count = 0;
    while (count < n && !this.cpu.halted) {
      this.step();
      count++;
    }
    return count as Operations;
  }

  // Granularity is one Z80 instruction; the actual delta may overshoot
  // by a few t-states. When halted, we only step if an IRQ is pending
  // (so runOneOp's IRQ-accept branch wakes the CPU rather than the
  // dispatcher fetching past the HALT byte). If iff1 is set the
  // caller's loop will give us another chance once irqLine asserts.
  runCycles(n: Cycles): Cycles {
    const start = this.cpu.cycles;
    while (this.cpu.cycles - start < n) {
      if (this.cpu.halted && !(this.cpu.irqLine && this.cpu.iff1)) break;
      this.step();
    }
    return (this.cpu.cycles - start) as Cycles;
  }

  snapshot(): SubCPUSnapshot {
    return {
      cpu: snapshotZ80(this.cpu),
      irqVector: this.irqVector,
      driveMode: this.driveMode,
    };
  }

  fromSnapshot(s: SubCPUSnapshot): void {
    restoreZ80(this.cpu, s.cpu);
    this.irqVector = s.irqVector;
    this.driveMode = s.driveMode;
  }
}
