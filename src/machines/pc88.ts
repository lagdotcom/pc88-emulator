import { Beeper } from "../chips/io/beeper.js";
import { Calendar } from "../chips/io/calendar.js";
import { IrqController } from "../chips/io/irq.js";
import { KanjiROM } from "../chips/io/kanji.js";
import { Keyboard } from "../chips/io/keyboard.js";
import { MiscPorts } from "../chips/io/misc.js";
import { PORT40_R, SystemController } from "../chips/io/sysctrl.js";
import { YM2203 } from "../chips/io/YM2203.js";
import { μPD3301 } from "../chips/io/μPD3301.js";
import { μPD765a } from "../chips/io/μPD765a.js";
import { μPD8251 } from "../chips/io/μPD8251.js";
import { μPD8255 } from "../chips/io/μPD8255.js";
import { μPD8257 } from "../chips/io/μPD8257.js";
import { resetZ80, snapshotZ80, Z80 } from "../chips/z80/cpu.js";
import { IOBus } from "../core/IOBus.js";
import { MemoryBus } from "../core/MemoryBus.js";
import { FloppyDrive } from "../disk/drive.js";
import type { Disk } from "../disk/types.js";
import { mHz, mOps } from "../flavour.makers.js";
import type { Cycles, Operations, u16 } from "../flavours.js";
import { getLogger } from "../log.js";
import { byte, word } from "../tools.js";
import type { PC88Config } from "./config.js";
import { DisplayRegisters } from "./display-regs.js";
import { type PC88Display, PC88TextDisplay } from "./pc88-display.js";
import { type LoadedROMs, PC88MemoryMap } from "./pc88-memory.js";
import { SubCPU } from "./sub-cpu.js";

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
// SOUND vector — YM2203 timer overflow asserts the same priority
// encoder line. SR boots with mask=0x02 (SOUND only enabled) so this
// is the first IRQ source the BIOS expects to fire post-EI.
const SOUND_IRQ_VECTOR = 0x02;

// Constructor options that don't belong in the variant config —
// runtime overrides chosen at machine-build time.
export interface PC88MachineOpts {
  // Force the FDC sub-CPU subsystem on regardless of
  // `config.disk.hasSubCpu`. The mkI PC-8031 external floppy unit
  // uses the same hardware interface as the mkII+ internal FDD-IF;
  // attaching one is a runtime decision rather than a hardware
  // variant. Drive count defaults to 2 when the variant declares 0.
  enableDiskSubsystem?: boolean;
}

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
  // mkII+ FDC sub-CPU. `null` when the variant has no internal
  // FDD-IF (mkI) or when the disk ROM wasn't loaded.
  ppi: μPD8255 | null;
  subcpu: SubCPU | null;
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
  readonly ppi: μPD8255 | null;
  readonly subcpu: SubCPU | null;
  // FloppyDrive instances attached to the FDC. One entry per drive
  // the variant declares (or 2 when the disk subsystem is force-
  // enabled via the constructor opt). Empty when there's no FDC.
  readonly floppy: FloppyDrive[] = [];

  constructor(
    public config: PC88Config,
    roms: LoadedROMs,
    opts: PC88MachineOpts = {},
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

    // Bridge sysctrl PMODE (port 0x32 bit 5) to the palette protocol
    // mode in DisplayRegisters. SR's V2 boot writes 0xA8 here, flipping
    // analogue mode on, and the palette init that follows expects two
    // bytes per port — see DisplayRegisters.setPMode for the toggle
    // reset that keeps "first byte after PMODE flip = low byte".
    this.sysctrl.onPModeChange = (pmode) => this.displayRegs.setPMode(pmode);

    // YM2203 timer-overflow → SOUND IRQ pipeline. The chip asserts
    // /IRQ on overflow; we gate it through the irq-controller mask
    // here so the Z80 only sees the IRQ when the BIOS has programmed
    // bit 1 of port 0xE6. SR boot programs mask=0x02 shortly after
    // its EI, so this is the first IRQ source to drive the boot
    // forward post-disk-init.
    if (this.opn) {
      this.opn.onIrq = () => {
        if (!this.irq.soundMasked()) {
          this.cpu.requestIrq(SOUND_IRQ_VECTOR);
        }
      };
    }

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
      roms.font ?? null,
    );

    // FDC sub-CPU subsystem. Wired when the variant declares an
    // internal FDD-IF (mkII+ hasSubCpu) OR when opts.enableDiskSubsystem
    // is set explicitly — that's the path mkI users take when they
    // attach the PC-8031 external floppy unit (same hardware
    // interface; just bolted on rather than internal). Either way
    // requires the disk ROM in `roms.disk`.
    const wantDisk = (config.disk.hasSubCpu || !!opts.enableDiskSubsystem)
      && !!roms.disk;
    if (wantDisk) {
      this.ppi = new μPD8255();
      this.ppi.registerMain(this.ioBus);
      const fdc = new μPD765a();
      this.subcpu = new SubCPU({ rom: roms.disk!, ppi: this.ppi, fdc });
      // Drive count: variant config takes precedence; fall back to 2
      // whenever the disk subsystem is wired but `count` is 0 (true
      // for the stock mkI config that declares no internal drives,
      // and for the test-fixture MKII_LIKE that spreads ...MKI).
      // Two drives covers "drive A: + drive B:" — the real-silicon
      // default for mkII+ and the PC-8031 add-on.
      const driveCount = config.disk.count > 0 ? config.disk.count : 2;
      for (let i = 0; i < driveCount; i++) {
        const drive = new FloppyDrive();
        this.floppy.push(drive);
        fdc.attachDrive(i, drive);
      }
      // Clear EXTON (bit 3 of port 0x40, active-low). Without this,
      // the N88-BASIC boot path at ROM 0x36DB reads the bit set and
      // skips PPI initialisation entirely — the disk subsystem is
      // wired but the BIOS never talks to it. With it cleared the
      // BIOS proceeds with `OUT (0xFF),0x91` (mode word) at 0x36EC
      // and the rest of the disk-detect handshake.
      this.sysctrl.systemStatus &= ~PORT40_R.EXTON;
    } else {
      if (config.disk.hasSubCpu && !roms.disk) {
        log.warn(
          "config.disk.hasSubCpu=true but roms.disk missing; sub-CPU not started",
        );
      }
      this.ppi = null;
      this.subcpu = null;
    }
  }

  // Insert a parsed disk into a drive. Spins the motor up
  // automatically — a real BIOS issues an explicit spin-up command
  // first, but auto-on lets headless tests skip that step. Throws
  // when the drive index is out of range or no FDC is attached.
  insertDisk(driveIdx: number, disk: Disk): void {
    const drive = this.floppy[driveIdx];
    if (!drive) {
      throw new Error(
        `insertDisk: drive ${driveIdx} doesn't exist (have ${this.floppy.length})`,
      );
    }
    drive.insert(disk);
    drive.motorOn = true;
  }

  // Reset to power-on state. Initial BASIC selection comes from DIP
  // port31 bit 2 (the bit the BIOS reads to decide which banner to
  // print). On real hardware the BASIC ROMs share a common entry that
  // branches on the DIP; modelling the choice up-front avoids needing
  // the shared entry to do a runtime ROM swap before printing.
  reset(): void {
    resetZ80(this.cpu);
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
    this.subcpu?.reset();
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
      cpu: snapshotZ80(this.cpu),
      memoryMap: {
        basicMode: this.memoryMap.basicMode,
        basicRomEnabled: this.memoryMap.basicROMEnabled,
        eromSlot: this.memoryMap.eromSlot,
        eromEnabled: this.memoryMap.eromEnabled,
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
      ppi: this.ppi?.snapshot() ?? null,
      subcpu: this.subcpu?.snapshot() ?? null,
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
  const { cpu, subcpu } = machine;
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

    const before = cpu.cycles;
    cpu.runOneOp();
    const delta = (cpu.cycles - before) as Cycles;
    if (subcpu) {
      // Both CPUs are 4 MHz on real silicon — drive the sub for the
      // same cycle delta the main just consumed. runCycles bails on
      // sub-side HALT, so a sub-CPU waiting on a non-existent FDC IRQ
      // doesn't burn the budget.
      subcpu.runCycles(delta);
    }
    machine.opn?.tick(delta);
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
