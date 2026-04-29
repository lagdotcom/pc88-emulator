import { Beeper } from "../chips/io/beeper.js";
import { Calendar } from "../chips/io/calendar.js";
import { i8255 } from "../chips/io/i8255.js";
import { SystemController } from "../chips/io/sysctrl.js";
import { μPD3301 } from "../chips/io/μPD3301.js";
import { μPD8257 } from "../chips/io/μPD8257.js";
import { Z80 } from "../chips/z80/cpu.js";
import { IOBus } from "../core/IOBus.js";
import { MemoryBus } from "../core/MemoryBus.js";
import type { PC88Config } from "./config.js";
import { type PC88Display, PC88TextDisplay } from "./pc88-display.js";
import {
  type LoadedRoms as MemoryLoadedRoms,
  PC88MemoryMap,
} from "./pc88-memory.js";

// VBL pump runs at 60 Hz (V1 mode default; CRTC reprogramming
// switches between 24 kHz and 15 kHz horizontal rates which gives
// either 60 Hz / 56 Hz / 24 kHz progressive — all tagged "60 Hz" for
// frontend purposes here). Z80 main clock is 4 MHz on mkI.
const Z80_HZ = 4_000_000;
export const VBL_HZ = 60;
const VBL_PERIOD_CYCLES = Math.round(Z80_HZ / VBL_HZ);
const VBL_PULSE_CYCLES = Math.round(Z80_HZ * 0.0008); // ~0.8 ms VBL pulse

export interface PC88MachineParts {
  cpu: Z80;
  memBus: MemoryBus;
  ioBus: IOBus;
  memoryMap: PC88MemoryMap;
  sysctrl: SystemController;
  ppi: i8255;
  crtc: μPD3301;
  dmac: μPD8257;
  calendar: Calendar;
  beeper: Beeper;
  display: PC88Display;
}

export class PC88Machine {
  readonly cpu: Z80;
  readonly memBus: MemoryBus;
  readonly ioBus: IOBus;
  readonly memoryMap: PC88MemoryMap;
  readonly sysctrl: SystemController;
  readonly ppi: i8255;
  readonly crtc: μPD3301;
  readonly dmac: μPD8257;
  readonly calendar: Calendar;
  readonly beeper: Beeper;
  readonly display: PC88Display;

  constructor(
    public config: PC88Config,
    roms: MemoryLoadedRoms,
  ) {
    this.memoryMap = new PC88MemoryMap(roms);
    this.memBus = new MemoryBus([this.memoryMap]);
    this.ioBus = new IOBus();

    this.beeper = new Beeper();
    this.sysctrl = new SystemController(this.memoryMap, this.beeper);
    this.ppi = new i8255();
    this.crtc = new μPD3301();
    this.dmac = new μPD8257();
    this.calendar = new Calendar();

    this.sysctrl.register(this.ioBus);
    this.ppi.register(this.ioBus);
    this.crtc.register(this.ioBus);
    this.dmac.register(this.ioBus);
    this.calendar.register(this.ioBus);

    this.cpu = new Z80(this.memBus, this.ioBus);
    this.display = new PC88TextDisplay(this.memoryMap);
  }

  // Reset to power-on state: PC=0, SP=0, IFFs cleared, ROM mapped.
  reset(): void {
    this.cpu.regs.PC = 0;
    this.cpu.regs.SP = 0;
    this.cpu.iff1 = false;
    this.cpu.iff2 = false;
    this.cpu.eiDelay = false;
    this.cpu.halted = false;
    this.cpu.irqLine = false;
    this.cpu.cycles = 0;
    this.memoryMap.setBasicRomEnabled(true);
    this.memoryMap.setBasicMode("n80");
    this.memoryMap.setE0RomEnabled(false);
    this.memoryMap.setVramEnabled(false);
    this.memoryMap.setTvramEnabled(false);
  }
}

export interface RunOptions {
  // Hard cap on instructions executed.
  maxOps?: number;
  // Run until this many CPU cycles have elapsed (instruction-level
  // granularity; the runner stops as soon as the cycle count
  // exceeds the limit). Set this OR maxOps.
  maxCycles?: number;
  // Periodic callback after every N instructions; useful for
  // diagnostics in the CLI runner. Return true to stop early.
  onProgress?: (ops: number) => boolean | void;
}

export interface RunResult {
  ops: number;
  cycles: number;
  reason: "max-ops" | "max-cycles" | "halted-no-irq" | "stopped";
}

// Run the machine, pumping a 60 Hz VBL onto the CPU's interrupt line.
// Stops on max-ops / max-cycles. If the CPU is HALTed and interrupts
// are disabled the runner aborts (otherwise it would loop forever
// burning cycles).
export function runMachine(
  machine: PC88Machine,
  opts: RunOptions = {},
): RunResult {
  const { cpu, sysctrl, crtc } = machine;
  const maxOps = opts.maxOps ?? 50_000_000;
  const maxCycles = opts.maxCycles ?? Number.POSITIVE_INFINITY;

  let ops = 0;
  let nextVblOn = VBL_PERIOD_CYCLES - VBL_PULSE_CYCLES;
  let nextVblOff = VBL_PERIOD_CYCLES;
  let vblActive = false;

  while (ops < maxOps && cpu.cycles < maxCycles) {
    if (!vblActive && cpu.cycles >= nextVblOn) {
      sysctrl.setVBlank(true);
      crtc.setVBlank(true);
      cpu.requestIrq();
      vblActive = true;
    }
    if (vblActive && cpu.cycles >= nextVblOff) {
      sysctrl.setVBlank(false);
      crtc.setVBlank(false);
      vblActive = false;
      nextVblOn += VBL_PERIOD_CYCLES;
      nextVblOff += VBL_PERIOD_CYCLES;
    }
    if (cpu.halted && !cpu.iff1) {
      return { ops, cycles: cpu.cycles, reason: "halted-no-irq" };
    }
    cpu.runOneOp();
    ops++;
    if (opts.onProgress && opts.onProgress(ops)) {
      return { ops, cycles: cpu.cycles, reason: "stopped" };
    }
  }

  return {
    ops,
    cycles: cpu.cycles,
    reason: cpu.cycles >= maxCycles ? "max-cycles" : "max-ops",
  };
}
