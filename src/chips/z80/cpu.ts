import logLib from "log";

import { MemoryBus } from "../../core/MemoryBus.js";
import type { u8 } from "../../flavours.js";
import { byte, isDefined, word } from "../../tools.js";
import {
  cbOpCodes,
  ddcbOpCodes,
  ddOpCodes,
  edOpCodes,
  fdcbOpCodes,
  fdOpCodes,
  opCodes,
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
  DDCB: ddcbOpCodes,
  ED: edOpCodes,
  FD: fdOpCodes,
  FDCB: fdcbOpCodes,
};

export class Z80 {
  cycles: number;
  eiDelay: boolean;
  halted: boolean;
  iff1: boolean;
  iff2: boolean;
  im: number;
  mCycleIndex: number;
  prefix: Prefix | undefined;
  regs: Z80Regs;

  constructor(
    public mem: MemoryBus,
    public io: MemoryBus,
  ) {
    this.cycles = 0;
    this.eiDelay = false;
    this.halted = false;
    this.iff1 = false;
    this.iff2 = false;
    this.im = 0;
    this.mCycleIndex = NaN;
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
  }

  runOneOp() {
    const ei = this.eiDelay;
    const pc = this.regs.PC;
    this.regs.OP = this.mem.read(pc);
    this.regs.PC++;

    const inst = this.decode();
    if (inst) {
      log.debug(`${word(pc)}: ${inst.mnemonic}`);
      this.mCycleIndex = 0;
      while (this.mCycleIndex < inst.mCycles.length) {
        const cycle = inst.mCycles[this.mCycleIndex]!;
        cycle.process(this);
        this.cycles += cycle.tStates;
        this.mCycleIndex++;
      }
    } else {
      log.debug(`${word(pc)}: INVALID ${byte(this.regs.OP)}`);
    }

    if (ei) this.eiDelay = false;
  }

  decode() {
    if (this.prefix?.type && opTables[this.prefix.type][this.regs.OP])
      return opTables[this.prefix.type][this.regs.OP];

    this.prefix = undefined;
    return opCodes[this.regs.OP];
  }

  incR() {
    const highBit = this.regs.R & 0x80;
    const rest = (this.regs.R & 0x7f) + 1;
    this.regs.R = highBit | (rest & 0x7f);
  }
}
