import logLib from "log";

import { IOBus } from "../../core/IOBus.js";
import { MemoryBus } from "../../core/MemoryBus.js";
import type { u8 } from "../../flavours.js";
import { byte, isDefined, word } from "../../tools.js";
import {
  cbOpCodes,
  ddCbOpCodes,
  ddOpCodes,
  edOpCodes,
  fdCbOpCodes,
  fdOpCodes,
  opCodes,
} from "./ops.js";
import {
  dispatchBase,
  dispatchCB,
  dispatchDD,
  dispatchED,
  dispatchFD,
  dispatchIndexedCB,
} from "./ops2.js";
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

const log = logLib.get("z80");

export type Prefix =
  | { type: "CB" }
  | { type: "ED" }
  | { type: "DD" }
  | { type: "FD" }
  | { type: "DDCB"; displacement: number }
  | { type: "FDCB"; displacement: number };

const opTables = {
  CB: cbOpCodes,
  DD: ddOpCodes,
  DDCB: ddCbOpCodes,
  ED: edOpCodes,
  FD: fdOpCodes,
  FDCB: fdCbOpCodes,
};

export class Z80 {
  cycles: number;
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
  // Set by an MCycle that wants the rest of an opcode's cycle list to be
  // skipped (the conditional branch in JP/CALL/RET, etc). Read and reset
  // by the per-opcode compiled `execute` function.
  aborted: boolean;
  // When true, runOneOp routes the unprefixed opcode through ops2's
  // hand-written giant switch instead of the table-driven dispatcher.
  // The two paths agree on SingleStepTests, but ops2 is the path that
  // passes Frank Cringle's zexdoc *and* zexall cleanly while the table
  // path fails four CRC families (cpd<r>, <inc,dec> (hl), <inc,dec>
  // (<ix,iy>+1), <rrd,rld>). ops2 is also ~4.5× faster on a full
  // zexdoc workload (~36 Mops/s vs ~8 Mops/s on Windows V8). Default
  // is on; flip to false to A/B against the legacy path.
  useDispatchBase: boolean;
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
    this.aborted = false;
    this.useDispatchBase = true;
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
    // Common to all: clear IFF1/IFF2, push current PC, exit HALT,
    // bump R like a normal M1 fetch would.
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
      const pc = this.regs.PC;
      const sp = (this.regs.SP - 2) & 0xffff;
      this.regs.SP = sp;
      this.mem.write(sp, pc & 0xff);
      this.mem.write((sp + 1) & 0xffff, (pc >> 8) & 0xff);

      if (this.im === 2) {
        const ptr =
          ((this.regs.I << 8) | (this.irqVector & 0xfe)) & 0xffff;
        const lo = this.mem.read(ptr);
        const hi = this.mem.read((ptr + 1) & 0xffff);
        this.regs.PC = (hi << 8) | lo;
        this.cycles += 19;
      } else {
        // IM 0 with bus byte 0xFF (RST 38h) and IM 1 both vector here.
        // IM 0 with non-RST bus bytes is not modelled; no PC-88 source
        // uses them.
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
    this.aborted = false;
    // Inline the universal M1 work: read the opcode byte, advance PC,
    // increment R, charge 4 t-states. compile() relies on this — it drops
    // the leading "plain opcode_fetch" MCycle from each opcode's compiled
    // execute body so simple ops like NOP have an empty body.
    //
    // DDCB / FDCB are the exception: by the time we get here the prefix
    // has already been resolved to {type:"DDCB",...} and what remains is
    // the operation byte, which on real Z80 is read as MR (not M1) — no
    // R increment, no 4-state charge. Those ops account their own cycle
    // cost in the per-opcode body.
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

    // ops2 now covers all seven prefix tables. The decode() fallback is
    // only kept for the (off-by-default) useDispatchBase=false path so
    // changes can be A/B-compared against the original table dispatcher.
    if (this.useDispatchBase) {
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
    } else {
      const inst = this.decode();
      if (inst) {
        inst.execute(this);
      } else {
        log.warn(`${word(pc)}: INVALID ${byte(regs.OP)}`);
      }
    }

    if (!this.qWritten) this.q = 0;
  }

  decode() {
    // Look up the op in the prefix-specific table and consume the prefix
    // on success. Clearing here (rather than on every entry) means that an
    // unknown opcode inside a prefix table falls through to the base
    // table and the prefix is naturally discarded — both branches end
    // with prefix = undefined.
    const prefix = this.prefix?.type;
    this.prefix = undefined;
    if (prefix && opTables[prefix][this.regs.OP]) {
      return opTables[prefix][this.regs.OP];
    }
    return opCodes[this.regs.OP];
  }

  incR() {
    const highBit = this.regs.R & 0x80;
    const rest = (this.regs.R & 0x7f) + 1;
    this.regs.R = highBit | (rest & 0x7f);
  }
}
