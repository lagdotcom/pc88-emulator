import { IOBus } from "../../core/IOBus.js";
import { MemoryBus } from "../../core/MemoryBus.js";
import type { Cycles, s8, u16, u8 } from "../../flavours.js";
import { isDefined } from "../../tools.js";
import {
  dispatchBase,
  dispatchCB,
  dispatchDD,
  dispatchED,
  dispatchFD,
  dispatchIndexedCB,
} from "./ops.js";
import {
  FLAG_C,
  FLAG_H,
  FLAG_N,
  FLAG_PV,
  FLAG_S,
  FLAG_X,
  FLAG_Y,
  FLAG_Z,
  makeRegs,
  type Z80Flags,
  type Z80Regs,
} from "./regs.js";

export type Prefix =
  | { type: "CB" }
  | { type: "ED" }
  | { type: "DD" }
  | { type: "FD" }
  | { type: "DDCB"; displacement: s8 }
  | { type: "FDCB"; displacement: s8 };

export class Z80 {
  cycles: Cycles;
  eiDelay: boolean;
  halted: boolean;
  iff1: boolean;
  iff2: boolean;
  im: number;
  // External maskable interrupt request. Drivers raise this with
  // requestIrq(); it's cleared on accept. Real silicon samples /INT on
  // the rising edge of the last T-state of the final M-cycle of every
  // instruction; we approximate that by sampling at the top of
  // runOneOp (i.e. instruction boundaries), which is the standard
  // simplification for any emulator not modelling t-state-level timing.
  irqLine: boolean;
  prefix: Prefix | undefined;
  // Q is a latch of "the F value last written by an instruction." It's read
  // by SCF and CCF to compute their X/Y bits as (A | Q) & {X,Y}. The value
  // visible at the start of an instruction is whatever the previous
  // instruction left there: F if F was written, 0 otherwise.
  q: u8;
  qWritten: boolean;
  regs: Z80Regs;

  constructor(
    public mem: MemoryBus,
    public io: IOBus,
  ) {
    this.cycles = 0;
    this.eiDelay = false;
    this.halted = false;
    this.iff1 = false;
    this.iff2 = false;
    this.im = 0;
    this.irqLine = false;
    this.q = 0;
    this.qWritten = false;
    this.regs = makeRegs();
  }

  updateFlags({ c, n, pv, x, h, y, z, s }: Z80Flags) {
    let flags: u8 = 0;
    const f = this.regs.F;

    if (c || (!isDefined(c) && f & FLAG_C)) flags |= FLAG_C;
    if (n || (!isDefined(n) && f & FLAG_N)) flags |= FLAG_N;
    if (x || (!isDefined(x) && f & FLAG_X)) flags |= FLAG_X;
    if (pv || (!isDefined(pv) && f & FLAG_PV)) flags |= FLAG_PV;
    if (y || (!isDefined(y) && f & FLAG_Y)) flags |= FLAG_Y;
    if (h || (!isDefined(h) && f & FLAG_H)) flags |= FLAG_H;
    if (z || (!isDefined(z) && f & FLAG_Z)) flags |= FLAG_Z;
    if (s || (!isDefined(s) && f & FLAG_S)) flags |= FLAG_S;

    this.regs.F = flags;
    this.q = flags;
    this.qWritten = true;
  }

  // Vector byte the device asserts on the data bus during the IRQ
  // acknowledge cycle. Used by IM 0 (treated as RST) and IM 2
  // (indexes the I:db table). Real PC-88 VBL puts 0x00 here; sub-CPU
  // and other sources use different bytes. Default 0xFF matches the
  // "/INT pulled low, no chip driving the bus" pattern most emulators
  // assume when nothing has set it explicitly.
  irqVector: u8 = 0xff;

  // Raise the maskable interrupt request line. Cleared on acceptance.
  // Idempotent: calling twice without an accept in between is the same
  // as calling once. The optional vector byte is what the source chip
  // would assert on the data bus — used in IM 0 / IM 2 dispatch.
  requestIrq(vector: u8 = 0xff): void {
    this.irqLine = true;
    this.irqVector = vector;
  }

  runOneOp() {
    // Maskable interrupt acceptance, sampled at the instruction
    // boundary. Conditions: IRQ asserted, IFF1 set, no in-flight EI
    // grace period, no pending prefix (would split a DD CB d xx into
    // an IRQ-acknowledged half).
    //
    // Dispatch by IM:
    //   IM 0 — execute the byte on the data bus as an opcode. Real
    //          silicon usually sees RST 38h (0xFF with /INT low), so
    //          we fast-path "vector to 0x0038". Other RST bytes work
    //          by shape but no PC-88 source uses them.
    //   IM 1 — vector to 0x0038, no bus byte read. 13 t-states.
    //   IM 2 — read PC from word at (I << 8) | (vector & 0xFE). 19
    //          t-states. Bit 0 of the vector is forced to 0 because
    //          the LSB of the read goes to the table's low byte.
    //
    // Common to all: clear IFF1/IFF2, exit HALT, bump R like a
    // normal M1 fetch would. Pushing PC + setting a vector PC
    // depends on the dispatch mode (some IM 0 cases neither push
    // nor change PC).
    if (
      this.irqLine &&
      this.iff1 &&
      !this.eiDelay &&
      this.prefix === undefined
    ) {
      this.irqLine = false;
      this.iff1 = false;
      this.iff2 = false;
      if (this.halted) this.halted = false;

      // IM 0 executes the byte the source asserts on the data bus
      // as the next opcode. Two cases the PC-88 actually uses:
      //   - 0xFF (RST 38h): the floating-bus default; behaves like
      //     IM 1 — push PC, vector to 0x0038.
      //   - 0x00 (NOP): the FDC sub-CPU's pc80s31k variant. The IRQ
      //     just exits HALT and lets the next instruction execute;
      //     no push, PC unchanged. This is essential for the
      //     EI;HALT;DI sequence the disk ROM uses to wait on FDC
      //     completions.
      // Other IM 0 bus bytes (RST 0/8/10/.., EX (SP),HL, etc.)
      // aren't reached by any PC-88 source.
      if (this.im === 0 && this.irqVector === 0x00) {
        this.cycles += 13;
        const r = this.regs.R;
        this.regs.R = (r & 0x80) | ((r + 1) & 0x7f);
        return;
      }

      const pc = this.regs.PC;
      const sp = (this.regs.SP - 2) & 0xffff;
      this.regs.SP = sp;
      this.mem.write(sp, pc & 0xff);
      this.mem.write((sp + 1) & 0xffff, (pc >> 8) & 0xff);

      if (this.im === 2) {
        const ptr = ((this.regs.I << 8) | (this.irqVector & 0xfe)) & 0xffff;
        const lo = this.mem.read(ptr);
        const hi = this.mem.read((ptr + 1) & 0xffff);
        this.regs.PC = (hi << 8) | lo;
        this.cycles += 19;
      } else {
        // IM 0 with bus byte 0xFF (RST 38h) and IM 1 both vector here.
        this.regs.PC = 0x0038;
        this.cycles += 13;
      }
      // Increment R like a normal M1 fetch would have.
      const r = this.regs.R;
      this.regs.R = (r & 0x80) | ((r + 1) & 0x7f);
      return;
    }

    // Consume any pending EI grace period at the start of each instruction.
    // The EI handler will re-set eiDelay during dispatch if this opcode is EI.
    this.eiDelay = false;
    // Q remains visible to this instruction (SCF/CCF read it). updateFlags
    // will set qWritten if F is modified; if no flag write happened by the
    // end of dispatch, Q is cleared so the next instruction sees 0.
    this.qWritten = false;
    // Cycle-list early-abort flag: belongs to the current instruction only.
    // The compiled execute function resets it on early return, but the
    // last-cycle abort case never gets there (it returns through the
    // bottom of the body), so we reset here too.
    // Universal M1 work: read the opcode byte, advance PC, increment
    // R, charge 4 t-states. DDCB/FDCB are the exception — by the
    // time we get here the prefix has already been resolved to
    // {type:"DDCB",...} and what remains is the operation byte, read
    // as MR (not M1) on real silicon — no R increment, no 4-state
    // charge. Those ops account their own cycle cost in the
    // dispatcher body.
    const regs = this.regs;
    const pc = regs.PC;
    regs.OP = this.mem.read(pc);
    regs.PC = pc + 1;
    const prefixType = this.prefix?.type;
    if (prefixType !== "DDCB" && prefixType !== "FDCB") {
      const r = regs.R;
      regs.R = (r & 0x80) | ((r + 1) & 0x7f);
      this.cycles += 4;
    }

    this.prefix = undefined;
    // prettier-ignore
    switch (prefixType) {
      case undefined: dispatchBase(this); break;
      case "ED": dispatchED(this); break;
      case "CB": dispatchCB(this); break;
      case "DD": dispatchDD(this); break;
      case "FD": dispatchFD(this); break;
      case "DDCB":
      case "FDCB": dispatchIndexedCB(this); break;
    }

    if (!this.qWritten) this.q = 0;
  }

  incR() {
    const highBit = this.regs.R & 0x80;
    const rest = (this.regs.R & 0x7f) + 1;
    this.regs.R = highBit | (rest & 0x7f);
  }
}

// Z80 user-manual RESET behaviour: PC, I, R, IFF1, IFF2, IM all clear
// to 0; SP, AF, BC, DE, HL, IX, IY and shadows are formally undefined
// on real silicon but we zero them for determinism (cross-reset
// register-state tests rely on this). Cycle count + halt + prefix +
// scratch slots + Q latch are also wiped — anything observable across
// a reset.
export function resetZ80(cpu: Z80): void {
  const r = cpu.regs;
  r.PC = 0; r.SP = 0;
  r.AF = 0; r.BC = 0; r.DE = 0; r.HL = 0;
  r.IX = 0; r.IY = 0;
  r.AF_ = 0; r.BC_ = 0; r.DE_ = 0; r.HL_ = 0;
  r.I = 0; r.R = 0;
  r.WZ = 0; r.OP = 0; r.OP2 = 0; r.OPx = 0;
  cpu.iff1 = false;
  cpu.iff2 = false;
  cpu.im = 0;
  cpu.eiDelay = false;
  cpu.halted = false;
  cpu.irqLine = false;
  cpu.cycles = 0;
  cpu.q = 0;
  cpu.qWritten = false;
  cpu.prefix = undefined;
}

export interface Z80CPUSnapshot {
  readonly PC: u16; readonly SP: u16;
  readonly AF: u16; readonly BC: u16; readonly DE: u16; readonly HL: u16;
  readonly IX: u16; readonly IY: u16;
  readonly AF_: u16; readonly BC_: u16; readonly DE_: u16; readonly HL_: u16;
  readonly I: u8; readonly R: u8;
  readonly iff1: boolean; readonly iff2: boolean;
  readonly im: number;
  readonly halted: boolean;
  readonly cycles: Cycles;
}

export function snapshotZ80(cpu: Z80): Z80CPUSnapshot {
  return {
    PC: cpu.regs.PC, SP: cpu.regs.SP,
    AF: cpu.regs.AF, BC: cpu.regs.BC, DE: cpu.regs.DE, HL: cpu.regs.HL,
    IX: cpu.regs.IX, IY: cpu.regs.IY,
    AF_: cpu.regs.AF_, BC_: cpu.regs.BC_, DE_: cpu.regs.DE_, HL_: cpu.regs.HL_,
    I: cpu.regs.I, R: cpu.regs.R,
    iff1: cpu.iff1, iff2: cpu.iff2,
    im: cpu.im,
    halted: cpu.halted,
    cycles: cpu.cycles,
  };
}

export function restoreZ80(cpu: Z80, s: Z80CPUSnapshot): void {
  const r = cpu.regs;
  r.PC = s.PC; r.SP = s.SP;
  r.AF = s.AF; r.BC = s.BC; r.DE = s.DE; r.HL = s.HL;
  r.IX = s.IX; r.IY = s.IY;
  r.AF_ = s.AF_; r.BC_ = s.BC_; r.DE_ = s.DE_; r.HL_ = s.HL_;
  r.I = s.I; r.R = s.R;
  cpu.iff1 = s.iff1;
  cpu.iff2 = s.iff2;
  cpu.im = s.im;
  cpu.halted = s.halted;
  cpu.cycles = s.cycles;
}
