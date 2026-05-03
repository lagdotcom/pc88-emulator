import type { IOBus } from "../../core/IOBus.js";
import type { Cycles, u8 } from "../../flavours.js";
import { getLogger } from "../../log.js";

const log = getLogger("opn");

// YM2203 (OPN) — Yamaha sound chip introduced on PC-8801 mkII SR.
// Standard Yamaha register-then-data interface:
//
//   0x44  W  address latch (selects internal register 0x00..0xFF)
//   0x45  RW data port (R = status / register read, W = register write)
//
// FH/MA replace this with YM2608 (OPNA) at 0x44-0x47 — same 0x44/0x45
// pair plus a second pair 0x46/0x47 for the OPNA's extra register
// bank. We only stub OPN here; OPNA can extend the same module.
//
// Status byte (read at 0x45 when no register-read is in progress):
//   bit 7  BUSY (1 = chip processing previous write; we always 0)
//   bit 6-2 reserved
//   bit 1  TIMER B overflow (0 = none)
//   bit 0  TIMER A overflow (0 = none)
//
// Implemented today: timer A + timer B with /IRQ output. FM/SSG
// synthesis is still un-modelled — register writes outside the
// timer block are latched but inert.
//
// Timer rates (per OPN datasheet, master clock = 4 MHz on PC-8801
// mkII SR onwards):
//
//   T_A = (1024 - NA) × 72 cycles  (one TA tick every 18 µs at 4 MHz)
//   T_B = (256  - NB) × 1152 cycles (one TB tick every 288 µs at 4 MHz)
//
// where NA is the 10-bit value `(reg 0x24 << 2) | (reg 0x25 & 0x03)`
// and NB is `reg 0x26` (8 bits). Mode register 0x27:
//
//   bit 0  LOAD A      (0=stop counter, 1=load + run)
//   bit 1  LOAD B      (idem)
//   bit 2  ENABLE A    (0=mask /IRQ output for A overflow)
//   bit 3  ENABLE B    (idem)
//   bit 4  RESET A     (write-1 → clear status bit 0; auto-clears)
//   bit 5  RESET B     (write-1 → clear status bit 1; auto-clears)
//   bits 6-7 CSM mode  (FM-related; not modelled)
//
// On overflow the chip latches the corresponding status bit. The
// /IRQ pin is asserted whenever any enabled timer's status bit is
// set; clearing the status (via reset bit) deasserts.
const TIMER_A_PRESCALER = 72;
const TIMER_B_PRESCALER = 1152;

const REG_TIMER_A_HIGH = 0x24;
const REG_TIMER_A_LOW = 0x25;
const REG_TIMER_B = 0x26;
const REG_MODE = 0x27;

const MODE_LOAD_A = 1 << 0;
const MODE_LOAD_B = 1 << 1;
const MODE_IRQ_A = 1 << 2;
const MODE_IRQ_B = 1 << 3;
const MODE_RESET_A = 1 << 4;
const MODE_RESET_B = 1 << 5;

const STATUS_OVERFLOW_A = 1 << 0;
const STATUS_OVERFLOW_B = 1 << 1;

export interface YM2203Snapshot {
  addr: u8;
  // Last-written value per register (0x00..0xFF). Real chip has
  // sparse register layout; we just latch every write.
  regs: u8[];
  status: u8;
  timerACounter: number;
  timerBCounter: number;
  timerAEnabled: boolean;
  timerBEnabled: boolean;
  timerAIrqEnabled: boolean;
  timerBIrqEnabled: boolean;
  prescalerA: number;
  prescalerB: number;
}

export class YM2203 {
  private addr: u8 = 0;
  private readonly regs: Uint8Array = new Uint8Array(256);

  // Timer state. Timer A counts down from `(1024 - NA)` and Timer B
  // from `(256 - NB)`; each underflow latches the matching status
  // bit and asserts /IRQ if the corresponding ENABLE bit is set.
  private status: u8 = 0;
  private timerACounter = 0;
  private timerBCounter = 0;
  private timerAEnabled = false;
  private timerBEnabled = false;
  private timerAIrqEnabled = false;
  private timerBIrqEnabled = false;
  // Prescaler accumulators: count Z80 cycles between timer ticks.
  // Resets to 0 each time the prescaler period (72 / 1152) is hit.
  private prescalerA = 0;
  private prescalerB = 0;

  // /IRQ output. Asserted (rising edge) whenever a timer overflow
  // sets its status bit AND the matching ENABLE bit in mode reg
  // 0x27 is set. PC88Machine wires this to gate-through the irq
  // controller's SOUND mask before requesting the Z80 IRQ.
  onIrq: (() => void) | null = null;

  snapshot(): YM2203Snapshot {
    return {
      addr: this.addr,
      regs: Array.from(this.regs),
      status: this.status,
      timerACounter: this.timerACounter,
      timerBCounter: this.timerBCounter,
      timerAEnabled: this.timerAEnabled,
      timerBEnabled: this.timerBEnabled,
      timerAIrqEnabled: this.timerAIrqEnabled,
      timerBIrqEnabled: this.timerBIrqEnabled,
      prescalerA: this.prescalerA,
      prescalerB: this.prescalerB,
    };
  }

  fromSnapshot(s: YM2203Snapshot): void {
    this.addr = s.addr;
    for (let i = 0; i < 256; i++) this.regs[i] = s.regs[i] ?? 0;
    this.status = s.status ?? 0;
    this.timerACounter = s.timerACounter ?? 0;
    this.timerBCounter = s.timerBCounter ?? 0;
    this.timerAEnabled = !!s.timerAEnabled;
    this.timerBEnabled = !!s.timerBEnabled;
    this.timerAIrqEnabled = !!s.timerAIrqEnabled;
    this.timerBIrqEnabled = !!s.timerBIrqEnabled;
    this.prescalerA = s.prescalerA ?? 0;
    this.prescalerB = s.prescalerB ?? 0;
  }

  // Drive the timers forward by `cycles` Z80 cycles. Called from
  // the main runner after each instruction; chip clock = main clock
  // on PC-88 (both 4 MHz). When a timer's reload value is at its
  // minimum (NA=0 / NB=0) the period is just the prescaler tick
  // itself, so callers must tick at instruction granularity to keep
  // the timer overflow rate accurate at fast settings.
  tick(cycles: Cycles): void {
    if (this.timerAEnabled) {
      this.prescalerA += cycles;
      while (this.prescalerA >= TIMER_A_PRESCALER) {
        this.prescalerA -= TIMER_A_PRESCALER;
        this.timerACounter--;
        if (this.timerACounter <= 0) {
          this.timerACounter = (1024 - this.timerARegValue()) & 0x3ff;
          if ((this.status & STATUS_OVERFLOW_A) === 0) {
            this.status |= STATUS_OVERFLOW_A;
            if (this.timerAIrqEnabled) this.onIrq?.();
          }
        }
      }
    }
    if (this.timerBEnabled) {
      this.prescalerB += cycles;
      while (this.prescalerB >= TIMER_B_PRESCALER) {
        this.prescalerB -= TIMER_B_PRESCALER;
        this.timerBCounter--;
        if (this.timerBCounter <= 0) {
          this.timerBCounter = (256 - (this.regs[REG_TIMER_B] ?? 0)) & 0xff;
          if ((this.status & STATUS_OVERFLOW_B) === 0) {
            this.status |= STATUS_OVERFLOW_B;
            if (this.timerBIrqEnabled) this.onIrq?.();
          }
        }
      }
    }
  }

  private timerARegValue(): number {
    return (
      (((this.regs[REG_TIMER_A_HIGH] ?? 0) << 2) |
        ((this.regs[REG_TIMER_A_LOW] ?? 0) & 0x03)) &
      0x3ff
    );
  }

  private writeMode(v: u8): void {
    const wasAEnabled = this.timerAEnabled;
    const wasBEnabled = this.timerBEnabled;
    this.timerAEnabled = (v & MODE_LOAD_A) !== 0;
    this.timerBEnabled = (v & MODE_LOAD_B) !== 0;
    this.timerAIrqEnabled = (v & MODE_IRQ_A) !== 0;
    this.timerBIrqEnabled = (v & MODE_IRQ_B) !== 0;
    // Reset bits clear the status latch but don't disable future
    // overflows; auto-clear on real silicon (we don't model the
    // bit being set in the latched reg byte either).
    if (v & MODE_RESET_A) this.status &= ~STATUS_OVERFLOW_A;
    if (v & MODE_RESET_B) this.status &= ~STATUS_OVERFLOW_B;
    // Rising edge of LOAD reloads the counter from the timer regs.
    // A 0→0 transition (still disabled) leaves the counter alone;
    // 1→1 (running) does NOT reload — that matches the OPN's
    // behaviour where the timer free-runs once started.
    if (this.timerAEnabled && !wasAEnabled) {
      this.timerACounter = (1024 - this.timerARegValue()) & 0x3ff;
      this.prescalerA = 0;
    }
    if (this.timerBEnabled && !wasBEnabled) {
      this.timerBCounter = (256 - (this.regs[REG_TIMER_B] ?? 0)) & 0xff;
      this.prescalerB = 0;
    }
  }

  register(bus: IOBus): void {
    bus.register(0x44, {
      name: "opn/addr",
      // Reading the address port is undefined on real silicon; some
      // titles read it expecting 0xFF or the last-written addr.
      // 0xFF matches the bus-default and keeps things quiet.
      read: () => 0xff,
      write: (_p, v) => {
        this.addr = v;
      },
    });
    bus.register(0x45, {
      name: "opn/data",
      read: () => this.status,
      write: (_p, v) => {
        this.regs[this.addr] = v;
        if (this.addr === REG_MODE) {
          this.writeMode(v);
          log.info(
            `mode 0x${v.toString(16)} (loadA=${this.timerAEnabled} loadB=${this.timerBEnabled} irqA=${this.timerAIrqEnabled} irqB=${this.timerBIrqEnabled})`,
          );
        } else {
          // Sound generation isn't modelled — every non-timer write
          // is a no-op. Surface as info so the BIOS's first
          // sound-init pass is visible in the log without grep.
          log.info(
            `reg 0x${this.addr.toString(16)} := 0x${v.toString(16)} (stub)`,
          );
        }
      },
    });
  }
}
