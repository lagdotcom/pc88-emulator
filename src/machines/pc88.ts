import { Beeper } from "../chips/io/beeper.js";
import { Calendar } from "../chips/io/calendar.js";
import { IrqController } from "../chips/io/irq.js";
import { KanjiROM } from "../chips/io/kanji.js";
import { Keyboard } from "../chips/io/keyboard.js";
import { MiscPorts } from "../chips/io/misc.js";
import { SystemController } from "../chips/io/sysctrl.js";
import { YM2203 } from "../chips/io/YM2203.js";
import { μPD3301 } from "../chips/io/μPD3301.js";
import { μPD8251 } from "../chips/io/μPD8251.js";
import { μPD8257 } from "../chips/io/μPD8257.js";
import { Z80 } from "../chips/z80/cpu.js";
import { IOBus } from "../core/IOBus.js";
import { MemoryBus } from "../core/MemoryBus.js";
import { mHz, mOps } from "../flavour.makers.js";
import type { Cycles, Operations, u16 } from "../flavours.js";
import { getLogger } from "../log.js";
import { byte, word } from "../tools.js";
import type { PC88Config } from "./config.js";
import { DisplayRegisters } from "./display-regs.js";
import { type PC88Display, PC88TextDisplay } from "./pc88-display.js";
import { type LoadedROMs, PC88MemoryMap } from "./pc88-memory.js";

const log = getLogger("pc88");

// VBL pump runs at 60 Hz (V1 mode default; CRTC reprogramming
// switches between 24 kHz and 15 kHz horizontal rates which gives
// either 60 Hz / 56 Hz / 24 kHz progressive — all tagged "60 Hz" for
// frontend purposes here). Z80 main clock is 4 MHz on mkI.
const Z80_HZ = mHz(4);
export const VBL_HZ = 60;
const VBL_PERIOD_CYCLES = Math.round(Z80_HZ / VBL_HZ);
const VBL_PULSE_CYCLES = Math.round(Z80_HZ * 0.0008); // ~0.8 ms VBL pulse
// Vector byte the VBL source asserts on the data bus during IM 2 IRQ
// acknowledge. The μPD8214 priority encoder on PC-88 emits 2 × source
// index, so RTC=0x00, SOUND=0x02, VBL=0x04, USART-Rx=0x06,
// USART-Tx/AUX=0x08 (matching MAME's pc8801.cpp). The BIOS lays its
// IM 2 jump table at I:0x00 + vector; reading PC from I:0x04 means
// VBL handlers live at the third pair of bytes.
const VBL_IRQ_VECTOR = 0x04;

export interface PC88MachineParts {
  cpu: Z80;
  memBus: MemoryBus;
  ioBus: IOBus;
  memoryMap: PC88MemoryMap;
  sysctrl: SystemController;
  keyboard: Keyboard;
  crtc: μPD3301;
  dmac: μPD8257;
  usart: μPD8251;
  kanji: KanjiROM;
  // OPN sound chip only present from mkII SR onwards. `null` on
  // pre-SR variants where ports 0x44/0x45 are unwired (idle 0xFF
  // from the bus default).
  opn: YM2203 | null;
  calendar: Calendar;
  beeper: Beeper;
  irq: IrqController;
  misc: MiscPorts;
  display: PC88Display;
  displayRegs: DisplayRegisters;
}

export class PC88Machine {
  readonly cpu: Z80;
  readonly memBus: MemoryBus;
  readonly ioBus: IOBus;
  readonly memoryMap: PC88MemoryMap;
  readonly sysctrl: SystemController;
  readonly keyboard: Keyboard;
  readonly crtc: μPD3301;
  readonly dmac: μPD8257;
  readonly usart: μPD8251;
  readonly kanji: KanjiROM;
  readonly opn: YM2203 | null;
  readonly calendar: Calendar;
  readonly beeper: Beeper;
  readonly irq: IrqController;
  readonly misc: MiscPorts;
  readonly display: PC88Display;
  readonly displayRegs: DisplayRegisters;

  constructor(
    public config: PC88Config,
    roms: LoadedROMs,
  ) {
    this.memoryMap = new PC88MemoryMap(roms, {
      tvramSeparate: config.memory.tvramSeparate,
    });
    this.memBus = new MemoryBus([this.memoryMap]);
    this.ioBus = new IOBus();

    this.beeper = new Beeper();
    this.sysctrl = new SystemController(
      this.memoryMap,
      this.beeper,
      config.dipSwitches,
    );
    this.keyboard = new Keyboard();
    this.crtc = new μPD3301();
    this.dmac = new μPD8257();
    // Three USART channels: ch 0 at 0x20/0x21 (CMT + RS-232 front
    // panel, mkI+), ch 1 at 0xC0/0xC1 and ch 2 at 0xC2/0xC3 (mkII+
    // expansion). N88-BASIC pokes the channel-1/channel-2 pair
    // unconditionally during boot.
    this.usart = new μPD8251(3);
    this.kanji = new KanjiROM();
    this.opn =
      config.sound.psg === "YM2203" || config.sound.psg === "YM2608"
        ? new YM2203()
        : null;
    this.calendar = new Calendar();
    this.irq = new IrqController();
    this.misc = new MiscPorts();
    this.displayRegs = new DisplayRegisters(this.memoryMap);

    this.sysctrl.register(this.ioBus);
    this.keyboard.register(this.ioBus);
    this.crtc.register(this.ioBus);
    this.dmac.register(this.ioBus);
    this.usart.registerChannel(this.ioBus, 0x20, 0);
    this.usart.registerChannel(this.ioBus, 0xc0, 1);
    this.usart.registerChannel(this.ioBus, 0xc2, 2);
    this.kanji.registerBank(this.ioBus, 0xe8, 0);
    this.kanji.registerBank(this.ioBus, 0xec, 1);
    if (this.opn) this.opn.register(this.ioBus);
    this.calendar.register(this.ioBus);
    this.irq.register(this.ioBus);
    this.misc.register(this.ioBus);
    this.displayRegs.register(this.ioBus);

    this.cpu = new Z80(this.memBus, this.ioBus);
    this.display = new PC88TextDisplay(
      this.memoryMap,
      this.crtc,
      this.dmac,
      this.sysctrl,
      this.displayRegs,
    );
  }

  // Reset to power-on state: PC=0, SP=0, IFFs cleared, ROM mapped.
  // Initial BASIC selection comes from DIP port31 bit 2 (the same
  // bit the BIOS reads to decide which BASIC banner to print). On
  // real hardware the BASIC ROMs share a common entry that branches
  // on the DIP; modelling the choice up-front avoids needing the
  // shared entry to do a runtime ROM swap before printing anything.
  reset(): void {
    // Z80 user manual RESET behaviour: PC, I, R, IFF1, IFF2, IM all
    // clear to 0; SP, AF, BC, DE, HL, IX, IY, AF', BC', DE', HL' are
    // formally undefined on real silicon but most emulators zero them
    // for determinism — and tests that observe register state across
    // a reset assume zeros, not whatever the previous run left
    // behind.
    this.cpu.regs.PC = 0;
    this.cpu.regs.SP = 0;
    this.cpu.regs.AF = 0;
    this.cpu.regs.BC = 0;
    this.cpu.regs.DE = 0;
    this.cpu.regs.HL = 0;
    this.cpu.regs.IX = 0;
    this.cpu.regs.IY = 0;
    this.cpu.regs.AF_ = 0;
    this.cpu.regs.BC_ = 0;
    this.cpu.regs.DE_ = 0;
    this.cpu.regs.HL_ = 0;
    this.cpu.regs.I = 0;
    this.cpu.regs.R = 0;
    // WZ (MEMPTR) is a real architectural latch — clear it. OP /
    // OP2 / OPx are dispatcher scratch slots; zero them so a leaked
    // value from a previous run can't be observed across reset.
    this.cpu.regs.WZ = 0;
    this.cpu.regs.OP = 0;
    this.cpu.regs.OP2 = 0;
    this.cpu.regs.OPx = 0;
    this.cpu.iff1 = false;
    this.cpu.iff2 = false;
    this.cpu.im = 0;
    this.cpu.eiDelay = false;
    this.cpu.halted = false;
    this.cpu.irqLine = false;
    this.cpu.cycles = 0;
    this.cpu.q = 0;
    this.cpu.qWritten = false;
    this.cpu.prefix = undefined;
    this.memoryMap.setBasicRomEnabled(true);
    this.memoryMap.setBasicMode(
      this.config.dipSwitches.port31 & 0x04 ? "n80" : "n88",
    );
    this.memoryMap.setEROMSlot(0);
    // E-ROM disabled at reset; the BIOS init path expects BASIC ROM
    // continuation at 0x6000-0x7FFF and explicitly enables an E-ROM
    // via port 0x32 when it wants one mapped in.
    this.memoryMap.setEROMEnabled(false);
    this.memoryMap.setVRAMEnabled(false);
  }

  // Aggregate every chip's persistent state into a single
  // JSON-friendly object. Used by the debugger today to render the
  // `chips` command, and intended as the foundation for savestates
  // — the same shape can be JSON.stringify'd to disk and restored
  // through chip.fromSnapshot() calls. Heavy buffers (TVRAM /
  // mainRam / GVRAM planes) are intentionally NOT included here;
  // a savestate writer will copy those separately because they're
  // base64-encoded for size reasons.
  snapshot() {
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
      memoryMap: {
        basicMode: this.memoryMap.basicMode,
        basicRomEnabled: this.memoryMap.basicROMEnabled,
        eromSlot: this.memoryMap.eromSlot,
        vramEnabled: this.memoryMap.vramEnabled,
      },
      sysctrl: this.sysctrl.snapshot(),
      crtc: this.crtc.snapshot(),
      dmac: this.dmac.snapshot(),
      usart: this.usart.snapshot(),
      kanji: this.kanji.snapshot(),
      keyboard: this.keyboard.snapshot(),
      opn: this.opn?.snapshot() ?? null,
      irq: this.irq.snapshot(),
      misc: this.misc.snapshot(),
      beeper: this.beeper.snapshot(),
      displayRegs: this.displayRegs.snapshot(),
    };
  }
}

export type MachineSnapshot = ReturnType<PC88Machine["snapshot"]>;

export interface RunOptions {
  // Hard cap on instructions executed.
  maxOps?: Operations;
  // Run until this many CPU cycles have elapsed (instruction-level
  // granularity; the runner stops as soon as the cycle count
  // exceeds the limit). Set this OR maxOps.
  maxCycles?: Cycles;
  // Periodic callback after every N instructions; useful for
  // diagnostics in the CLI runner. Return true to stop early.
  onProgress?: (ops: Operations) => boolean | void;
}

export interface RunResult {
  ops: Operations;
  cycles: Cycles;
  reason: "max-ops" | "max-cycles" | "halted-no-irq" | "stopped";
  // Snapshot of CPU state at stop. Useful for tracking down "BIOS got
  // stuck somewhere"-class failures without re-running.
  finalPC: u16;
  finalSP: u16;
  iff1: boolean;
  halted: boolean;
  // Z80 interrupt mode (0 / 1 / 2). PC-88 BIOS uses IM 2 with a
  // vector table at I:0x00; if the runner stops with im=0 the BIOS
  // hasn't programmed the mode yet (usually means it bailed early).
  im: number;
  // I register (high byte of IM 2 vector table base).
  iReg: number;
  // Number of VBL IRQs the runner injected (for sanity-checking
  // interrupt-driven boot paths).
  vblIrqsRaised: number;
  // Number of VBL pulses suppressed because the IRQ mask register
  // disabled bit 0. If non-zero, the BIOS has explicitly programmed
  // the mask to ignore VBL — usually transient during init.
  vblIrqsMasked: number;
}

// VBL pump state shared between the headless runner and the
// interactive debugger. Initialise via makeVblState(); tick it once
// per CPU instruction by calling pumpVbl() — that handles both the
// "raise" and "lower" edges of the pulse and the IRQ injection.
export interface VblState {
  nextVblOn: number;
  nextVblOff: number;
  vblActive: boolean;
  vblIrqsRaised: number;
  vblIrqsMasked: number;
}

export function makeVblState(): VblState {
  return {
    nextVblOn: VBL_PERIOD_CYCLES - VBL_PULSE_CYCLES,
    nextVblOff: VBL_PERIOD_CYCLES,
    vblActive: false,
    vblIrqsRaised: 0,
    vblIrqsMasked: 0,
  };
}

export function pumpVbl(machine: PC88Machine, state: VblState): void {
  const { cpu, sysctrl, crtc, irq } = machine;
  if (!state.vblActive && cpu.cycles >= state.nextVblOn) {
    sysctrl.setVBlank(true);
    crtc.setVBlank(true);
    if (!irq.vblMasked()) {
      cpu.requestIrq(VBL_IRQ_VECTOR);
      state.vblIrqsRaised++;
    } else {
      state.vblIrqsMasked++;
    }
    state.vblActive = true;
  }
  if (state.vblActive && cpu.cycles >= state.nextVblOff) {
    sysctrl.setVBlank(false);
    crtc.setVBlank(false);
    state.vblActive = false;
    state.nextVblOn += VBL_PERIOD_CYCLES;
    state.nextVblOff += VBL_PERIOD_CYCLES;
  }
}

// Step the CPU through one *logical* instruction — i.e. consume any
// pending prefix bytes (CB / DD / ED / FD / DDCB / FDCB) so each
// caller-visible step lands on the next instruction boundary, not
// in the middle of a multi-byte op. Mirrors the loop pattern the
// SingleStepTests harness uses.
export function stepOneInstruction(machine: PC88Machine): void {
  const { cpu } = machine;
  let safety = 8;
  do {
    cpu.runOneOp();
    safety--;
  } while (cpu.prefix !== undefined && safety > 0);
}

// Run the machine, pumping a 60 Hz VBL onto the CPU's interrupt line.
// Stops on max-ops / max-cycles. If the CPU is HALTed and interrupts
// are disabled the runner aborts (otherwise it would loop forever
// burning cycles). VBL IRQ delivery respects the mask register at
// 0xE6 — masked pulses still flip the status bit (the BIOS can poll
// it) but don't assert /INT.
export function runMachine(
  machine: PC88Machine,
  opts: RunOptions = {},
): RunResult {
  const { cpu } = machine;
  const maxOps = opts.maxOps ?? mOps(50);
  const maxCycles = opts.maxCycles ?? Number.POSITIVE_INFINITY;

  let ops = 0;
  const vbl = makeVblState();
  let stopReason: RunResult["reason"] | null = null;

  while (ops < maxOps && cpu.cycles < maxCycles) {
    pumpVbl(machine, vbl);
    if (cpu.halted && !cpu.iff1) {
      stopReason = "halted-no-irq";
      break;
    }

    if (process.env.LOG_CPU) {
      log.trace(
        `pc=${word(cpu.regs.PC)} op=${byte(cpu.mem.read(cpu.regs.PC))}`,
      );
    }

    cpu.runOneOp();
    ops++;
    if (opts.onProgress && opts.onProgress(ops)) {
      stopReason = "stopped";
      break;
    }
  }

  if (!stopReason) {
    stopReason = cpu.cycles >= maxCycles ? "max-cycles" : "max-ops";
  }

  return {
    ops,
    cycles: cpu.cycles,
    reason: stopReason,
    finalPC: cpu.regs.PC,
    finalSP: cpu.regs.SP,
    iff1: cpu.iff1,
    halted: cpu.halted,
    im: cpu.im,
    iReg: cpu.regs.I,
    vblIrqsRaised: vbl.vblIrqsRaised,
    vblIrqsMasked: vbl.vblIrqsMasked,
  };
}
