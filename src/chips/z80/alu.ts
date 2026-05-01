// Z80 ALU + flag/control helpers shared by the dispatcher in
// `ops2.ts`. Pure functions over a `Z80` instance — no MCycle, no
// closures, no opcode tables. Each helper carries a brief comment
// for the non-obvious flag rules; canonical references are Sean
// Young's "Undocumented Z80 Documented" and David Banks's
// hoglet67/Z80Decoder Undocumented-Flags wiki.

import { parity } from "../../numbers.js";
import type { u8, u16 } from "../../flavours.js";
import type { Z80 } from "./cpu.js";
import {
  carry,
  FLAG_C,
  FLAG_H,
  FLAG_N,
  FLAG_X,
  FLAG_Y,
  type Reg16,
} from "./regs.js";

export function do_add_a(cpu: Z80, value: u8, useCarry: boolean): void {
  const a = cpu.regs.A;
  const c = useCarry ? carry(cpu.regs.F) : 0;
  const sum = a + value + c;
  const result = sum & 0xff;
  cpu.regs.A = result;
  cpu.updateFlags({
    c: sum > 0xff,
    n: 0,
    pv: ((~(a ^ value) & (a ^ result)) >> 7) & 1,
    h: ((a & 0xf) + (value & 0xf) + c) & 0x10,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

export function do_sub_a(cpu: Z80, value: u8, useCarry: boolean): void {
  const a = cpu.regs.A;
  const c = useCarry ? carry(cpu.regs.F) : 0;
  const diff = a - value - c;
  const result = diff & 0xff;
  cpu.regs.A = result;
  cpu.updateFlags({
    c: diff < 0,
    n: 1,
    pv: (((a ^ value) & (a ^ result)) >> 7) & 1,
    h: ((a & 0xf) - (value & 0xf) - c) & 0x10,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

export function do_cp_a(cpu: Z80, value: u8): void {
  const a = cpu.regs.A;
  const diff = a - value;
  const result = diff & 0xff;
  cpu.updateFlags({
    c: diff < 0,
    n: 1,
    pv: (((a ^ value) & (a ^ result)) >> 7) & 1,
    h: ((a & 0xf) - (value & 0xf)) & 0x10,
    z: result === 0,
    s: result & 0x80,
    // CP takes X/Y from the operand, not the result.
    x: value & FLAG_X,
    y: value & FLAG_Y,
  });
}

export function inc8(cpu: Z80, old: u8): u8 {
  const result = (old + 1) & 0xff;
  cpu.updateFlags({
    n: 0,
    pv: old === 0x7f,
    h: (old & 0xf) === 0xf,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
  return result;
}

export function dec8(cpu: Z80, old: u8): u8 {
  const result = (old - 1) & 0xff;
  cpu.updateFlags({
    n: 1,
    pv: old === 0x80,
    h: (old & 0xf) === 0,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
  return result;
}

export function do_add16(cpu: Z80, dst: Reg16, value: u16): void {
  const old = cpu.regs[dst];
  cpu.regs.WZ = (old + 1) & 0xffff;
  const sum = old + value;
  const result = sum & 0xffff;
  cpu.regs[dst] = result;
  const high = result >> 8;
  cpu.updateFlags({
    c: sum > 0xffff,
    n: 0,
    h: ((old & 0xfff) + (value & 0xfff)) & 0x1000,
    x: high & FLAG_X,
    y: high & FLAG_Y,
  });
}

// 16-bit ADC: HL = HL + value + C. Sets full flag set including S/Z/PV
// (which plain ADD HL,rr leaves alone). Used only by the ED-prefixed
// ADC HL,rr variants.
export function do_adc_hl(cpu: Z80, value: u16): void {
  const hl = cpu.regs.HL;
  const c = cpu.regs.F & FLAG_C ? 1 : 0;
  cpu.regs.WZ = (hl + 1) & 0xffff;
  const sum = hl + value + c;
  const result = sum & 0xffff;
  cpu.regs.HL = result;
  const high = result >> 8;
  cpu.updateFlags({
    c: sum > 0xffff,
    n: 0,
    pv: ((~(hl ^ value) & (hl ^ result)) >> 15) & 1,
    h: ((hl & 0xfff) + (value & 0xfff) + c) & 0x1000,
    z: result === 0,
    s: high & 0x80,
    x: high & FLAG_X,
    y: high & FLAG_Y,
  });
}

// 16-bit SBC: HL = HL - value - C. Standard SUB direction flags.
export function do_sbc_hl(cpu: Z80, value: u16): void {
  const hl = cpu.regs.HL;
  const c = cpu.regs.F & FLAG_C ? 1 : 0;
  cpu.regs.WZ = (hl + 1) & 0xffff;
  const diff = hl - value - c;
  const result = diff & 0xffff;
  cpu.regs.HL = result;
  const high = result >> 8;
  cpu.updateFlags({
    c: diff < 0,
    n: 1,
    pv: (((hl ^ value) & (hl ^ result)) >> 15) & 1,
    h: ((hl & 0xfff) - (value & 0xfff) - c) & 0x1000,
    z: result === 0,
    s: high & 0x80,
    x: high & FLAG_X,
    y: high & FLAG_Y,
  });
}

// NEG: A = -A. Equivalent to "SUB A from 0" with full flag effect.
export function do_neg(cpu: Z80): void {
  const a = cpu.regs.A;
  const diff = 0 - a;
  const result = diff & 0xff;
  cpu.regs.A = result;
  cpu.updateFlags({
    c: a !== 0,
    n: 1,
    pv: a === 0x80,
    h: (0 - (a & 0xf)) & 0x10,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

// LD A,I and LD A,R both load A and update flags including PV from IFF2.
export function do_ld_a_ir(cpu: Z80, value: u8): void {
  cpu.regs.A = value;
  cpu.updateFlags({
    n: 0,
    pv: cpu.iff2 ? 1 : 0,
    h: 0,
    z: value === 0,
    s: value & 0x80,
    x: value & FLAG_X,
    y: value & FLAG_Y,
  });
}

// RRD: rotate the lower nibble of A and the (HL) byte one digit to
// the right.  A_lo <- (HL)_lo;  (HL)_lo <- (HL)_hi;  (HL)_hi <- old
// A_lo. A's high nibble is unchanged. Flags from the new A. Caller
// is responsible for writing OPx back to (HL).
export function do_rrd(cpu: Z80, value: u8): void {
  const aLo = cpu.regs.A & 0x0f;
  const aHi = cpu.regs.A & 0xf0;
  const newMem = (aLo << 4) | (value >> 4);
  const newA = aHi | (value & 0x0f);
  cpu.regs.A = newA;
  cpu.regs.WZ = (cpu.regs.HL + 1) & 0xffff;
  cpu.updateFlags({
    n: 0,
    pv: parity(newA),
    h: 0,
    z: newA === 0,
    s: newA & 0x80,
    x: newA & FLAG_X,
    y: newA & FLAG_Y,
  });
  cpu.regs.OPx = newMem;
}

// RLD: rotate the lower nibble of A and the (HL) byte one digit to
// the left.  A_lo <- (HL)_hi;  (HL)_hi <- (HL)_lo;  (HL)_lo <- old
// A_lo. A's high nibble is unchanged.
export function do_rld(cpu: Z80, value: u8): void {
  const aLo = cpu.regs.A & 0x0f;
  const aHi = cpu.regs.A & 0xf0;
  const newMem = ((value << 4) | aLo) & 0xff;
  const newA = aHi | (value >> 4);
  cpu.regs.A = newA;
  cpu.regs.WZ = (cpu.regs.HL + 1) & 0xffff;
  cpu.updateFlags({
    n: 0,
    pv: parity(newA),
    h: 0,
    z: newA === 0,
    s: newA & 0x80,
    x: newA & FLAG_X,
    y: newA & FLAG_Y,
  });
  cpu.regs.OPx = newMem;
}

// Block transfer flag rules (LDI/LDD/LDIR/LDDR).
//   v = byte transferred; n = (A + v).
//   N = 0; H = 0; PV = (BC != 0); C, Z, S unchanged.
//   For non-repeat AND for the last iteration of a repeat (BC == 0):
//     X = bit 3 of n; Y = bit 1 of n.
//   Repeating non-final iteration (BC != 0 after dec, caller has
//   already done PC -= 2): X/Y from PC.high — the post-decrement
//   PC, NOT (PC+1).
export function do_ld_block(cpu: Z80, value: u8, repeating: boolean): void {
  let x: number;
  let y: number;
  if (repeating) {
    const pcHi = (cpu.regs.PC >> 8) & 0xff;
    x = pcHi & FLAG_X;
    y = pcHi & FLAG_Y;
  } else {
    const n = (cpu.regs.A + value) & 0xff;
    x = n & FLAG_X;
    y = n & 0x02;
  }
  cpu.updateFlags({
    n: 0,
    pv: cpu.regs.BC !== 0,
    h: 0,
    x,
    y,
  });
}

// Block compare flag rules (CPI/CPD/CPIR/CPDR). result = A - (HL).
//   N = 1; H = half-borrow; Z = (result == 0); S = sign(result);
//   PV = (BC != 0); C unchanged.
//   Non-repeat (or last iteration of CPIR/CPDR):
//     X = bit 3 of (result - H), Y = bit 1.
//   Repeating non-final iteration (BC != 0 AND no match, caller has
//   already pulled PC back by 2): X/Y from PC.high (post-decrement).
export function do_cp_block(
  cpu: Z80,
  value: u8,
  repeating: boolean,
): void {
  const a = cpu.regs.A;
  const result = (a - value) & 0xff;
  const h = ((a & 0xf) - (value & 0xf)) & 0x10;
  let x: number;
  let y: number;
  if (repeating) {
    const pcHi = (cpu.regs.PC >> 8) & 0xff;
    x = pcHi & FLAG_X;
    y = pcHi & FLAG_Y;
  } else {
    const n = (result - (h ? 1 : 0)) & 0xff;
    x = n & FLAG_X;
    y = n & 0x02;
  }
  cpu.updateFlags({
    n: 1,
    pv: cpu.regs.BC !== 0,
    h,
    z: result === 0,
    s: result & 0x80,
    x,
    y,
  });
}

// I/O block flag computation. Singles (INI/IND/OUTI/OUTD) and the
// terminating iteration of repeats (B == 0) follow Sean Young:
//   N = bit 7 of value; H = C = (base > 0xff);
//   PV = parity((base & 7) ^ B); S/Z from B.
//   X/Y from B (or from PC.high on a repeating non-final iteration).
//
// On a repeating non-final iteration (INIR/INDR/OTIR/OTDR with
// B != 0 after decrement) the 5 T-state PC-decrement M-cycle adds
// a "fix-up" that overrides H and toggles PF. Per David Banks
// (hoglet67/Z80Decoder/wiki/Undocumented-Flags) and MAME's
// `block_io_interrupted_flags()`:
//
//   if (CF) {
//     if (value & 0x80) { seed = (B-1) & 7; HF = (B & 0x0F) == 0x00; }
//     else              { seed = (B+1) & 7; HF = (B & 0x0F) == 0x0F; }
//   } else {
//     seed = B & 7;     // HF stays at the singles value
//   }
//   PF = PF_singles XNOR parity(seed)
//
// where B is post-decrement, value is the byte transferred, CF is
// the singles-step carry (= H = (base > 0xff)). Y/X from PC.high
// (post-decrement; PC -= 2 has happened by the time we're called).
export function do_io_block_flags(
  cpu: Z80,
  value: u8,
  base: number,
  repeating: boolean,
): void {
  const b = cpu.regs.B;
  let x: number;
  let y: number;
  if (repeating) {
    const pcHi = (cpu.regs.PC >> 8) & 0xff;
    x = pcHi & FLAG_X;
    y = pcHi & FLAG_Y;
  } else {
    x = b & FLAG_X;
    y = b & FLAG_Y;
  }

  const cFlag = base > 0xff;
  const singlesPv = parity(((base & 7) ^ b) & 0xff);
  let h: number | boolean = cFlag;
  let pv: boolean = singlesPv;

  if (repeating) {
    let seed: number;
    if (cFlag) {
      if (value & 0x80) {
        seed = (b - 1) & 7;
        h = (b & 0x0f) === 0x00;
      } else {
        seed = (b + 1) & 7;
        h = (b & 0x0f) === 0x0f;
      }
    } else {
      seed = b & 7;
      // HF unchanged from singles.
    }
    pv = singlesPv === parity(seed);
  }

  cpu.updateFlags({
    n: value & 0x80,
    pv,
    h,
    c: cFlag,
    z: b === 0,
    s: b & 0x80,
    x,
    y,
  });
}

export function rla(cpu: Z80): void {
  const c = cpu.regs.A >> 7;
  cpu.regs.A = (cpu.regs.A << 1) | carry(cpu.regs.F);
  cpu.updateFlags({
    c,
    n: 0,
    h: 0,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

export function rlca(cpu: Z80): void {
  const c = cpu.regs.A >> 7;
  cpu.regs.A = (cpu.regs.A << 1) | c;
  cpu.updateFlags({
    c,
    n: 0,
    h: 0,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

export function rra(cpu: Z80): void {
  const c = cpu.regs.A & 0x01;
  cpu.regs.A = (cpu.regs.A >> 1) | (carry(cpu.regs.F) << 7);
  cpu.updateFlags({
    c,
    n: 0,
    h: 0,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

export function rrca(cpu: Z80): void {
  const c = cpu.regs.A & 0x01;
  cpu.regs.A = (cpu.regs.A >> 1) | (c << 7);
  cpu.updateFlags({
    c,
    n: 0,
    h: 0,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

function exchange_regs(cpu: Z80, a: Reg16, b: Reg16): void {
  const temp = cpu.regs[a];
  cpu.regs[a] = cpu.regs[b];
  cpu.regs[b] = temp;
}

export function ex_af(cpu: Z80): void {
  exchange_regs(cpu, "AF", "AF_");
}

export function exx(cpu: Z80): void {
  exchange_regs(cpu, "BC", "BC_");
  exchange_regs(cpu, "DE", "DE_");
  exchange_regs(cpu, "HL", "HL_");
}

// EX DE,HL is unaffected by DD/FD prefixes — it always swaps DE
// with HL, not IX/IY. (Sean Young, "The Undocumented Z80
// Documented".)
export function ex_de_hl(cpu: Z80): void {
  exchange_regs(cpu, "DE", "HL");
}

export function cpl(cpu: Z80): void {
  cpu.regs.A = ~cpu.regs.A;
  cpu.updateFlags({
    n: 1,
    h: 1,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

export function daa(cpu: Z80): void {
  const oldA = cpu.regs.A;
  const f = cpu.regs.F;
  const c = (f & FLAG_C) !== 0;
  const h = (f & FLAG_H) !== 0;
  const n = (f & FLAG_N) !== 0;

  let correction = 0;
  let setC = c;
  if (h || (oldA & 0xf) > 9) correction |= 0x06;
  if (c || oldA > 0x99) {
    correction |= 0x60;
    setC = true;
  }

  const raw = n ? oldA - correction : oldA + correction;
  const result = raw & 0xff;
  cpu.regs.A = result;

  cpu.updateFlags({
    c: setC,
    pv: parity(result),
    h: (oldA ^ correction ^ raw) & FLAG_H,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

// SCF / CCF X/Y are tied to A *and* the F^Q latch — bits "leak"
// from F when the previous instruction didn't write F (Q=0 so F^Q =
// F), and zero out when it did (Q=F so F^Q = 0, leaving only A).
export function scf(cpu: Z80): void {
  const xy = cpu.regs.A | (cpu.regs.F ^ cpu.q);
  cpu.updateFlags({
    c: 1,
    n: 0,
    x: xy & FLAG_X,
    h: 0,
    y: xy & FLAG_Y,
  });
}

export function ccf(cpu: Z80): void {
  const c = carry(cpu.regs.F);
  const xy = cpu.regs.A | (cpu.regs.F ^ cpu.q);
  cpu.updateFlags({
    c: !c,
    n: 0,
    x: xy & FLAG_X,
    h: c,
    y: xy & FLAG_Y,
  });
}

export function di(cpu: Z80): void {
  cpu.iff1 = false;
  cpu.iff2 = false;
  cpu.eiDelay = false;
}

export function ei(cpu: Z80): void {
  cpu.iff1 = true;
  cpu.iff2 = true;
  cpu.eiDelay = true;
}

export function prefix_ed(cpu: Z80): void {
  cpu.prefix = { type: "ED" };
}

export function prefix_dd(cpu: Z80): void {
  cpu.prefix = { type: "DD" };
}

export function prefix_fd(cpu: Z80): void {
  cpu.prefix = { type: "FD" };
}

export function prefix_cb(cpu: Z80): void {
  cpu.prefix = { type: "CB" };
}

export function and_a(cpu: Z80, value: u8): void {
  const result = cpu.regs.A & value;
  cpu.regs.A = result;
  cpu.updateFlags({
    c: 0,
    n: 0,
    pv: parity(result),
    h: 1,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

export function or_a(cpu: Z80, value: u8): void {
  const result = cpu.regs.A | value;
  cpu.regs.A = result;
  cpu.updateFlags({
    c: 0,
    n: 0,
    pv: parity(result),
    h: 0,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

export function xor_a(cpu: Z80, value: u8): void {
  const result = cpu.regs.A ^ value;
  cpu.regs.A = result;
  cpu.updateFlags({
    c: 0,
    n: 0,
    pv: parity(result),
    h: 0,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

