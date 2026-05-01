import type { μPD765a } from "../chips/io/μPD765a.js";
import type { μPD8255 } from "../chips/io/μPD8255.js";
import { Z80 } from "../chips/z80/cpu.js";
import { IOBus } from "../core/IOBus.js";
import { MemoryBus, type MemoryProvider } from "../core/MemoryBus.js";
import type { Cycles, Operations, u16, u8 } from "../flavours.js";
import { getLogger } from "../log.js";

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
  readonly cpu: {
    readonly PC: u16;
    readonly SP: u16;
    readonly AF: u16;
    readonly BC: u16;
    readonly DE: u16;
    readonly HL: u16;
    readonly IX: u16;
    readonly IY: u16;
    readonly AF_: u16;
    readonly BC_: u16;
    readonly DE_: u16;
    readonly HL_: u16;
    readonly I: u8;
    readonly R: u8;
    readonly iff1: boolean;
    readonly iff2: boolean;
    readonly im: number;
    readonly halted: boolean;
    readonly cycles: Cycles;
  };
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
        log.info(`IRQ vector latched=0x${value.toString(16)}`);
      },
    });
    this.ioBus.register(PORT_DRIVE_MODE, {
      name: "subcpu/drive-mode",
      write: (_p, value) => {
        this.driveMode = value;
        log.info(`drive mode=0x${value.toString(16)}`);
      },
    });

    this.cpu = new Z80(this.memBus, this.ioBus);

    if (this.fdc) {
      this.fdc.register(this.ioBus);
      // FDC INT line: command-completion / data-ready raises an IRQ
      // on the sub-CPU. The vector byte the FDC drives onto the data
      // bus is whatever the sub last latched at port 0xF0 (real
      // hardware loops it back); we forward the latched vector here.
      this.fdc.onInterrupt = () => {
        this.cpu.requestIrq(this.irqVector);
      };
    }
  }

  reset(): void {
    const r = this.cpu.regs;
    r.PC = 0;
    r.SP = 0;
    r.AF = 0;
    r.BC = 0;
    r.DE = 0;
    r.HL = 0;
    r.IX = 0;
    r.IY = 0;
    r.AF_ = 0;
    r.BC_ = 0;
    r.DE_ = 0;
    r.HL_ = 0;
    r.I = 0;
    r.R = 0;
    r.WZ = 0;
    r.OP = 0;
    r.OP2 = 0;
    r.OPx = 0;
    this.cpu.iff1 = false;
    this.cpu.iff2 = false;
    this.cpu.im = 0;
    this.cpu.halted = false;
    this.cpu.cycles = 0;
    this.cpu.prefix = undefined;
    this.cpu.eiDelay = false;
    this.cpu.q = 0;
    this.cpu.qWritten = false;
    this.cpu.irqLine = false;
    this.ram.fill(0);
    this.irqVector = 0;
    this.driveMode = 0;
  }

  // Run one full instruction (driven through prefix consumption — same
  // termination rule the main runner uses).
  step(): void {
    this.cpu.runOneOp();
    while (this.cpu.prefix !== undefined) this.cpu.runOneOp();
  }

  // Run up to `n` instructions, stopping early on HALT. Returns how
  // many were actually executed.
  runOps(n: Operations): Operations {
    let count = 0;
    while (count < n && !this.cpu.halted) {
      this.step();
      count++;
    }
    return count as Operations;
  }

  // Run until the cycle delta reaches `n` or HALT, whichever comes
  // first. Granularity is one Z80 instruction; the actual delta may
  // overshoot by a few t-states.
  runCycles(n: Cycles): Cycles {
    const start = this.cpu.cycles;
    while (this.cpu.cycles - start < n && !this.cpu.halted) {
      this.step();
    }
    return (this.cpu.cycles - start) as Cycles;
  }

  snapshot(): SubCPUSnapshot {
    return {
      cpu: {
        PC: this.cpu.regs.PC,
        SP: this.cpu.regs.SP,
        AF: this.cpu.regs.AF,
        BC: this.cpu.regs.BC,
        DE: this.cpu.regs.DE,
        HL: this.cpu.regs.HL,
        IX: this.cpu.regs.IX,
        IY: this.cpu.regs.IY,
        AF_: this.cpu.regs.AF_,
        BC_: this.cpu.regs.BC_,
        DE_: this.cpu.regs.DE_,
        HL_: this.cpu.regs.HL_,
        I: this.cpu.regs.I,
        R: this.cpu.regs.R,
        iff1: this.cpu.iff1,
        iff2: this.cpu.iff2,
        im: this.cpu.im,
        halted: this.cpu.halted,
        cycles: this.cpu.cycles,
      },
      irqVector: this.irqVector,
      driveMode: this.driveMode,
    };
  }

  fromSnapshot(s: SubCPUSnapshot): void {
    const r = this.cpu.regs;
    r.PC = s.cpu.PC;
    r.SP = s.cpu.SP;
    r.AF = s.cpu.AF;
    r.BC = s.cpu.BC;
    r.DE = s.cpu.DE;
    r.HL = s.cpu.HL;
    r.IX = s.cpu.IX;
    r.IY = s.cpu.IY;
    r.AF_ = s.cpu.AF_;
    r.BC_ = s.cpu.BC_;
    r.DE_ = s.cpu.DE_;
    r.HL_ = s.cpu.HL_;
    r.I = s.cpu.I;
    r.R = s.cpu.R;
    this.cpu.iff1 = s.cpu.iff1;
    this.cpu.iff2 = s.cpu.iff2;
    this.cpu.im = s.cpu.im;
    this.cpu.halted = s.cpu.halted;
    this.cpu.cycles = s.cpu.cycles;
    this.irqVector = s.irqVector;
    this.driveMode = s.driveMode;
  }
}
