import type { u8, u16 } from "../../flavours.js";
import { asS8, asU16, parity } from "../../numbers.js";
import type { Z80 } from "./cpu.js";
import {
  carry,
  FLAG_C,
  FLAG_H,
  FLAG_N,
  FLAG_PV,
  FLAG_S,
  FLAG_X,
  FLAG_Y,
  FLAG_Z,
  type Reg8,
  type Reg16,
} from "./regs.js";

export interface MCycle {
  type: "M1" | "MR" | "MW" | "IOR" | "IOW" | "INT";
  tStates: number;
  process: (cpu: Z80) => void;
  // Set on cycles that may set cpu.aborted to skip the rest of the
  // opcode (the conditional check in JR/JP/CALL/RET). compile() omits
  // the per-cycle abort check on the ~95% of opcodes that can't abort.
  canAbort?: boolean;
}

export interface OpCode {
  code: u8;
  mnemonic: string;
  mCycles: MCycle[];
  // Pre-composed dispatcher that runs all of mCycles in order, advances
  // cpu.cycles, and respects cpu.aborted as an early-exit signal.
  // Lifted out of runOneOp so each instruction's hot path is one indirect
  // call into a length-specialised function instead of a generic loop.
  execute: (cpu: Z80) => void;
}

// Compose a cycle list into a single function. Specialised for the common
// short lengths (most opcodes have ≤4 cycles, the longest in this codebase
// is CALL nn at 6) so V8 sees a flat function body it can inline aggressively.
// When no cycle in the list can abort, emits a no-branch fast path that
// adds the total t-states once at the end instead of per cycle.
function compile(cycles: MCycle[]): (cpu: Z80) => void {
  // Drop a plain opcode_fetch (process === noop, no extra t-states) from
  // the head — runOneOp already does the M1 work for it. opcode_fetch_and
  // with a post hook is kept so the post still runs.
  if (cycles.length > 0 && cycles[0]!.process === noop) {
    cycles = cycles.slice(1);
  }
  const n = cycles.length;
  let totalT = 0;
  let canAbort = false;
  for (let i = 0; i < n; i++) {
    totalT += cycles[i]!.tStates;
    if (cycles[i]!.canAbort) canAbort = true;
  }

  if (!canAbort) {
    if (n === 0) {
      return totalT === 0
        ? noop
        : (cpu) => {
            cpu.cycles += totalT;
          };
    }
    if (n === 1) {
      const a = cycles[0]!.process;
      return (cpu) => {
        a(cpu);
        cpu.cycles += totalT;
      };
    }
    if (n === 2) {
      const a = cycles[0]!.process;
      const b = cycles[1]!.process;
      return (cpu) => {
        a(cpu);
        b(cpu);
        cpu.cycles += totalT;
      };
    }
    if (n === 3) {
      const a = cycles[0]!.process;
      const b = cycles[1]!.process;
      const c = cycles[2]!.process;
      return (cpu) => {
        a(cpu);
        b(cpu);
        c(cpu);
        cpu.cycles += totalT;
      };
    }
    if (n === 4) {
      const a = cycles[0]!.process;
      const b = cycles[1]!.process;
      const c = cycles[2]!.process;
      const d = cycles[3]!.process;
      return (cpu) => {
        a(cpu);
        b(cpu);
        c(cpu);
        d(cpu);
        cpu.cycles += totalT;
      };
    }
    if (n === 5) {
      const a = cycles[0]!.process;
      const b = cycles[1]!.process;
      const c = cycles[2]!.process;
      const d = cycles[3]!.process;
      const e = cycles[4]!.process;
      return (cpu) => {
        a(cpu);
        b(cpu);
        c(cpu);
        d(cpu);
        e(cpu);
        cpu.cycles += totalT;
      };
    }
    const procs = cycles.map((c) => c.process);
    return (cpu) => {
      for (let i = 0; i < n; i++) procs[i]!(cpu);
      cpu.cycles += totalT;
    };
  }

  // Abortable variants — must add cycles per-step and check the flag.
  if (n === 2) {
    const a = cycles[0]!.process;
    const tA = cycles[0]!.tStates;
    const b = cycles[1]!.process;
    const tB = cycles[1]!.tStates;
    return (cpu) => {
      a(cpu);
      cpu.cycles += tA;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
      b(cpu);
      cpu.cycles += tB;
    };
  }
  if (n === 3) {
    const a = cycles[0]!.process;
    const tA = cycles[0]!.tStates;
    const b = cycles[1]!.process;
    const tB = cycles[1]!.tStates;
    const c = cycles[2]!.process;
    const tC = cycles[2]!.tStates;
    return (cpu) => {
      a(cpu);
      cpu.cycles += tA;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
      b(cpu);
      cpu.cycles += tB;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
      c(cpu);
      cpu.cycles += tC;
    };
  }
  if (n === 4) {
    const a = cycles[0]!.process;
    const tA = cycles[0]!.tStates;
    const b = cycles[1]!.process;
    const tB = cycles[1]!.tStates;
    const c = cycles[2]!.process;
    const tC = cycles[2]!.tStates;
    const d = cycles[3]!.process;
    const tD = cycles[3]!.tStates;
    return (cpu) => {
      a(cpu);
      cpu.cycles += tA;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
      b(cpu);
      cpu.cycles += tB;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
      c(cpu);
      cpu.cycles += tC;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
      d(cpu);
      cpu.cycles += tD;
    };
  }
  const procs = cycles.map((c) => c.process);
  const tStates = cycles.map((c) => c.tStates);
  return (cpu) => {
    for (let i = 0; i < n; i++) {
      procs[i]!(cpu);
      cpu.cycles += tStates[i]!;
      if (cpu.aborted) {
        cpu.aborted = false;
        return;
      }
    }
  };
}

// A RegSet describes the substitution applied to opcodes where HL/H/L/(HL)
// would otherwise appear. The unprefixed table is built with HL_SET; the DD
// and FD prefixes pass IX_SET / IY_SET (and a different addressing mode for
// memory accesses, handled separately).
export interface RegSet {
  rp: "HL" | "IX" | "IY";
  rh: "H" | "IXH" | "IYH";
  rl: "L" | "IXL" | "IYL";
  addr: "hl" | "ix-d" | "iy-d";
}

const HL_SET: RegSet = { rp: "HL", rh: "H", rl: "L", addr: "hl" };
const IX_SET: RegSet = { rp: "IX", rh: "IXH", rl: "IXL", addr: "ix-d" };
const IY_SET: RegSet = { rp: "IY", rh: "IYH", rl: "IYL", addr: "iy-d" };

const op = (code: u8, mnemonic: string, mCycles: MCycle[]): OpCode => ({
  code,
  mnemonic,
  mCycles,
  execute: compile(mCycles),
});

const noop = () => {};

// Every opcode begins with an M1 fetch. runOneOp already does the work
// common to every opcode (read byte into OP, advance PC, incR, charge 4
// t-states); this MCycle exists to attach a per-opcode post hook (e.g.
// the prefix setter for ED/CB or the flag check for JR cc / RET cc) and
// to reserve cycle accounting for the rare conditional check that costs
// 5 t-states instead of 4.
//
// The base-case `opcode_fetch` (no post, no extra t-states) is detected
// by reference equality in compile() and dropped entirely — the cycle
// list it would otherwise contribute to is empty for ops like NOP,
// shrinking the compiled execute body to nothing more than the cycles
// the opcode actually does.
const opcode_fetch_and = (
  post?: (cpu: Z80, op: u8) => void,
  tStates = 4,
): MCycle => ({
  type: "M1",
  // tStates here is the *additional* cost beyond runOneOp's base 4. The
  // conditional fetch helpers pass 5; we subtract 4 so totalT only counts
  // the extra. Plain (4-state) opcode_fetch has tStates=0 in this scheme.
  tStates: tStates - 4,
  process: post ? (cpu) => post(cpu, cpu.regs.OP) : noop,
});
const opcode_fetch = opcode_fetch_and();

const fetch_byte = (process: (cpu: Z80, data: u8) => void): MCycle => ({
  type: "MR",
  tStates: 3,
  process: (cpu) => {
    cpu.regs.OP = cpu.mem.read(cpu.regs.PC++);
    process(cpu, cpu.regs.OP);
  },
});

const fetch_r8 = (reg: Reg8) =>
  fetch_byte((cpu, data) => (cpu.regs[reg] = data));
const fetch_a = fetch_r8("A");
const fetch_b = fetch_r8("B");
const fetch_c = fetch_r8("C");
const fetch_d = fetch_r8("D");
const fetch_e = fetch_r8("E");
const fetch_w = fetch_r8("W");
const fetch_z = fetch_r8("Z");
const fetch_sph = fetch_r8("SPH");
const fetch_spl = fetch_r8("SPL");
const fetch_opx = fetch_r8("OPx");

const opcode_fetch_and_load_r8_from_r8 = (dst: Reg8, src: Reg8) =>
  opcode_fetch_and((cpu) => (cpu.regs[dst] = cpu.regs[src]));

const mem_read = (
  addr: Reg16,
  dst: Reg8,
  post?: (cpu: Z80) => void,
): MCycle => ({
  type: "MR",
  tStates: 3,
  process: (cpu) => {
    cpu.regs[dst] = cpu.mem.read(cpu.regs[addr]);
    post?.(cpu);
  },
});

const mem_write = (
  addr: Reg16,
  src: Reg8,
  post?: (cpu: Z80, addr: u16) => void,
): MCycle => ({
  type: "MW",
  tStates: 3,
  process: (cpu) => {
    cpu.mem.write(cpu.regs[addr], cpu.regs[src]);
    post?.(cpu, cpu.regs[addr]);
  },
});

const dec_r16 = (reg: Reg16): MCycle => ({
  type: "INT",
  tStates: 2,
  process: (cpu) => cpu.regs[reg]--,
});

const inc_r16 = (reg: Reg16): MCycle => ({
  type: "INT",
  tStates: 2,
  process: (cpu) => cpu.regs[reg]++,
});

// Indexed-mode helpers used by buildOpTable. For HL_SET they collapse to
// plain (HL) addressing; for IX_SET/IY_SET they emit a displacement fetch
// followed by an internal-delay cycle, with the resolved address in WZ.

const fetch_disp_to_wz = (set: RegSet): MCycle =>
  fetch_byte((cpu, d) => {
    cpu.regs.WZ = (cpu.regs[set.rp] + asS8(d)) & 0xffff;
  });

const internal_delay = (tStates: number): MCycle => ({
  type: "INT",
  tStates,
  process: () => {},
});

// MCycles to run before an indexed memory access. Empty for plain HL.
function indexed_prefix(set: RegSet): MCycle[] {
  if (set.addr === "hl") return [];
  return [fetch_disp_to_wz(set), internal_delay(5)];
}

// The address register holding the resolved memory location during the
// access. For HL it's HL itself; for indexed sets WZ was set by the prefix.
function indexed_addr(set: RegSet): Reg16 {
  return set.addr === "hl" ? "HL" : "WZ";
}

// Mnemonic fragment for indexed addressing.
function addr_mnemonic(set: RegSet): string {
  return set.addr === "hl" ? "HL" : `${set.rp}+d`;
}

export function do_add_a(cpu: Z80, value: u8, useCarry: boolean) {
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

export function do_sub_a(cpu: Z80, value: u8, useCarry: boolean) {
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

export function do_cp_a(cpu: Z80, value: u8) {
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

export function do_add16(cpu: Z80, dst: Reg16, value: u16) {
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

const add_hl_rr = (src: Reg16, set: RegSet): MCycle => ({
  type: "INT",
  tStates: 7,
  process: (cpu) => do_add16(cpu, set.rp, cpu.regs[src]),
});

// 16-bit ADC: HL = HL + value + C. Sets full flag set including S/Z/PV
// (which plain ADD HL,rr leaves alone). Used only by the ED-prefixed
// ADC HL,rr variants.
export function do_adc_hl(cpu: Z80, value: u16) {
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
export function do_sbc_hl(cpu: Z80, value: u16) {
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

const adc_hl_rr = (src: Reg16): MCycle => ({
  type: "INT",
  tStates: 7,
  process: (cpu) => do_adc_hl(cpu, cpu.regs[src]),
});

const sbc_hl_rr = (src: Reg16): MCycle => ({
  type: "INT",
  tStates: 7,
  process: (cpu) => do_sbc_hl(cpu, cpu.regs[src]),
});

// NEG: A = -A. Equivalent to "SUB A from 0" with full flag effect.
export function do_neg(cpu: Z80) {
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
export function do_ld_a_ir(cpu: Z80, value: u8) {
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

// RRD: rotate the lower nibble of A and the (HL) byte one digit to the
// right.  A_lo <- (HL)_lo;  (HL)_lo <- (HL)_hi;  (HL)_hi <- old A_lo.
// A's high nibble is unchanged. Flags are derived from the new A.
export function do_rrd(cpu: Z80, value: u8) {
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

// RLD: rotate the lower nibble of A and the (HL) byte one digit to the
// left.  A_lo <- (HL)_hi;  (HL)_hi <- (HL)_lo;  (HL)_lo <- old A_lo.
export function do_rld(cpu: Z80, value: u8) {
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
//   For repeating iterations (BC != 0 after dec, PC has been pulled back):
//     X = bit 3 of (PC+1).high; Y = bit 5 of (PC+1).high.
export function do_ld_block(cpu: Z80, value: u8, repeating: boolean) {
  let x: number;
  let y: number;
  if (repeating) {
    const pcHi = ((cpu.regs.PC + 1) >> 8) & 0xff;
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
//   Repeating (BC != 0 AND no match, PC has been pulled back):
//     X = bit 3 of (PC+1).high; Y = bit 5 of (PC+1).high.
export function do_cp_block(cpu: Z80, value: u8, repeating: boolean) {
  const a = cpu.regs.A;
  const result = (a - value) & 0xff;
  const h = ((a & 0xf) - (value & 0xf)) & 0x10;
  let x: number;
  let y: number;
  if (repeating) {
    const pcHi = ((cpu.regs.PC + 1) >> 8) & 0xff;
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

// I/O block flag rules (INI/IND/OUTI/OUTD and repeats). Per Sean Young:
//   B = B - 1 (already done by caller).
//   k = value just read/written.
//   For IN family:  base = ((C ± 1) & 0xff) + k
//   For OUT family: base = L + k
//   N = bit 7 of k; H = C = (base > 0xff);
//   PV = parity((base & 7) ^ B); S/Z from B.
//   Non-repeat / last iteration: X/Y from B.
//   Repeating iteration: X/Y from (PC+1).high.
//   The H/PV behaviour during repeat follows additional silicon-level quirks
//   not yet captured here (see TODO note above buildEdTable).
export function do_io_block_flags(
  cpu: Z80,
  value: u8,
  base: number,
  repeating: boolean,
) {
  const b = cpu.regs.B;
  let x: number;
  let y: number;
  if (repeating) {
    const pcHi = ((cpu.regs.PC + 1) >> 8) & 0xff;
    x = pcHi & FLAG_X;
    y = pcHi & FLAG_Y;
  } else {
    x = b & FLAG_X;
    y = b & FLAG_Y;
  }
  cpu.updateFlags({
    n: value & 0x80,
    pv: parity(((base & 7) ^ b) & 0xff),
    h: base > 0xff,
    c: base > 0xff,
    z: b === 0,
    s: b & 0x80,
    x,
    y,
  });
}

const opcode_fetch_and_inc_r8 = (reg: Reg8) =>
  opcode_fetch_and((cpu: Z80) => (cpu.regs[reg] = inc8(cpu, cpu.regs[reg])));

const opcode_fetch_and_dec_r8 = (reg: Reg8) =>
  opcode_fetch_and((cpu: Z80) => (cpu.regs[reg] = dec8(cpu, cpu.regs[reg])));

const inc_opx: MCycle = {
  type: "INT",
  tStates: 1,
  process: (cpu) => (cpu.regs.OPx = inc8(cpu, cpu.regs.OPx)),
};
const dec_opx: MCycle = {
  type: "INT",
  tStates: 1,
  process: (cpu) => (cpu.regs.OPx = dec8(cpu, cpu.regs.OPx)),
};

export function rla(cpu: Z80) {
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

export function rlca(cpu: Z80) {
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

export function rra(cpu: Z80) {
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

export function rrca(cpu: Z80) {
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

function exchange_regs(cpu: Z80, a: Reg16, b: Reg16) {
  const temp = cpu.regs[a];
  cpu.regs[a] = cpu.regs[b];
  cpu.regs[b] = temp;
}

export function ex_af(cpu: Z80) {
  exchange_regs(cpu, "AF", "AF_");
}

export function cpl(cpu: Z80) {
  cpu.regs.A = ~cpu.regs.A;
  cpu.updateFlags({
    n: 1,
    h: 1,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

export function daa(cpu: Z80) {
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

export function scf(cpu: Z80) {
  // F[5,3] = (A | (F ^ Q)) & 0x28 — bits "leak" from F when the previous
  // instruction didn't write F (Q=0 so F^Q = F), and zero out when it did
  // (Q=F so F^Q = 0, leaving only A).
  const xy = cpu.regs.A | (cpu.regs.F ^ cpu.q);
  cpu.updateFlags({
    c: 1,
    n: 0,
    x: xy & FLAG_X,
    h: 0,
    y: xy & FLAG_Y,
  });
}

export function ccf(cpu: Z80) {
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

export function halt(cpu: Z80) {
  cpu.halted = true;
  // now we wait until an interrupt is handled, then do cpu.regs.PC++
}

const jp_hl =
  (set: RegSet) =>
  (cpu: Z80): void => {
    cpu.regs.PC = cpu.regs[set.rp];
  };

export function di(cpu: Z80) {
  cpu.iff1 = false;
  cpu.iff2 = false;
  cpu.eiDelay = false;
}

export function ei(cpu: Z80) {
  cpu.iff1 = true;
  cpu.iff2 = true;
  cpu.eiDelay = true;
}

export function exx(cpu: Z80) {
  exchange_regs(cpu, "BC", "BC_");
  exchange_regs(cpu, "DE", "DE_");
  exchange_regs(cpu, "HL", "HL_");
}

// EX DE,HL is unaffected by DD/FD prefixes — it always swaps DE with HL,
// not IX/IY. (Sean Young, "The Undocumented Z80 Documented".)
export function ex_de_hl(cpu: Z80) {
  exchange_regs(cpu, "DE", "HL");
}

export function prefix_ed(cpu: Z80) {
  cpu.prefix = { type: "ED" };
}

export function prefix_dd(cpu: Z80) {
  cpu.prefix = { type: "DD" };
}

export function prefix_fd(cpu: Z80) {
  cpu.prefix = { type: "FD" };
}

export function prefix_cb(cpu: Z80) {
  cpu.prefix = { type: "CB" };
}

// CB after DD/FD opens the DDCB/FDCB family. Unlike plain CB, this fetches
// a signed displacement byte before the actual op byte and parks IX/IY+d in
// WZ. The op byte is then dispatched on the next runOneOp via the DDCB or
// FDCB table. Note: real Z80 fetches the op byte as MR (no R increment),
// which the DDCB ops handle by using a no-op first MCycle instead of
// opcode_fetch_and.
function prefix_cb_for(set: RegSet): MCycle[] {
  if (set.addr === "hl") {
    return [opcode_fetch_and(prefix_cb)];
  }
  const target = set.addr === "ix-d" ? "DDCB" : "FDCB";
  return [
    opcode_fetch,
    fetch_byte((cpu, d) => {
      const disp = asS8(d);
      cpu.regs.WZ = (cpu.regs[set.rp] + disp) & 0xffff;
      cpu.prefix = { type: target, displacement: disp };
    }),
  ];
}

const no_op: u8 = 0;
const skip_jump: u8 = 0xe0;

const dec_b_set_skip_relative_jump: MCycle = {
  type: "INT",
  tStates: 1,
  process: (cpu) => {
    cpu.regs.B--;
    cpu.regs.OPx = cpu.regs.B === 0 ? skip_jump : no_op;
  },
};

const fetch_displacement_respect_skip_jump: MCycle = {
  ...fetch_byte((cpu, data) => {
    if (cpu.regs.OPx === skip_jump) {
      cpu.aborted = true;
      cpu.regs.OPx = no_op;
      return;
    }
    cpu.regs.WZ = asU16(asS8(data));
  }),
  canAbort: true,
};

const relative_jump_wz: MCycle = {
  type: "INT",
  tStates: 5,
  process: (cpu) => {
    cpu.regs.WZ += cpu.regs.PC;
    cpu.regs.PC = cpu.regs.WZ;
  },
};

const jump_if_flag_set = (mask: u8) => (cpu: Z80) => {
  cpu.regs.OPx = cpu.regs.F & mask ? no_op : skip_jump;
};
const jump_if_flag_not_set = (mask: u8) => (cpu: Z80) => {
  cpu.regs.OPx = cpu.regs.F & mask ? skip_jump : no_op;
};

const opcode_fetch_ret_if_flag_set = (flag: u8): MCycle => ({
  ...opcode_fetch_and((cpu) => {
    if (!(cpu.regs.F & flag)) cpu.aborted = true;
  }, 5),
  canAbort: true,
});
const opcode_fetch_ret_if_flag_not_set = (flag: u8): MCycle => ({
  ...opcode_fetch_and((cpu) => {
    if (cpu.regs.F & flag) cpu.aborted = true;
  }, 5),
  canAbort: true,
});

const fetch_w_goto_wz_respect_skip_jump: MCycle = {
  ...fetch_byte((cpu, data) => {
    cpu.regs.W = data;
    if (cpu.regs.OPx === skip_jump) {
      cpu.aborted = true;
      cpu.regs.OPx = no_op;
    } else cpu.regs.PC = cpu.regs.WZ;
  }),
  canAbort: true,
};

const fetch_w_respect_skip_jump: MCycle = {
  ...fetch_byte((cpu, data) => {
    cpu.regs.W = data;
    if (cpu.regs.OPx === skip_jump) {
      cpu.aborted = true;
      cpu.regs.OPx = no_op;
    }
  }),
  canAbort: true,
};

const add_a_r8 = (src: Reg8, useCarry: boolean) => (cpu: Z80) =>
  do_add_a(cpu, cpu.regs[src], useCarry);

const add_a_imm = (useCarry: boolean) => (cpu: Z80, data: u8) =>
  do_add_a(cpu, data, useCarry);

const sub_a_r8 = (src: Reg8, useCarry: boolean) => (cpu: Z80) =>
  do_sub_a(cpu, cpu.regs[src], useCarry);

const sub_a_imm = (useCarry: boolean) => (cpu: Z80, data: u8) =>
  do_sub_a(cpu, data, useCarry);

const cp_a_r8 = (src: Reg8) => (cpu: Z80) => do_cp_a(cpu, cpu.regs[src]);

const cp_a_imm = (cpu: Z80, data: u8) => do_cp_a(cpu, data);

export function and_a(cpu: Z80, value: u8) {
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
const and_a_r8 = (src: Reg8) => (cpu: Z80) => and_a(cpu, cpu.regs[src]);

export function or_a(cpu: Z80, value: u8) {
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
const or_a_r8 = (src: Reg8) => (cpu: Z80) => or_a(cpu, cpu.regs[src]);

export function xor_a(cpu: Z80, value: u8) {
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
const xor_a_r8 = (src: Reg8) => (cpu: Z80) => xor_a(cpu, cpu.regs[src]);

const dec_sp: MCycle = {
  type: "INT",
  tStates: 1,
  process: (cpu) => cpu.regs.SP--,
};

const inc_sp: MCycle = {
  type: "INT",
  tStates: 1,
  process: (cpu) => cpu.regs.SP++,
};

function inc_sp_goto_wz(cpu: Z80) {
  cpu.regs.SP++;
  cpu.regs.PC = cpu.regs.WZ;
}

const io_read_az: MCycle = {
  type: "IOR",
  tStates: 4,
  process: (cpu) => {
    const port: u16 = (cpu.regs.A << 8) | cpu.regs.Z;
    cpu.regs.WZ = port + 1;
    cpu.regs.A = cpu.io.read(port);
  },
};

const io_read_bc = (dst: Reg8): MCycle => ({
  type: "IOR",
  tStates: 4,
  process: (cpu) => {
    const port = cpu.regs.BC;
    const value = cpu.io.read(port);
    cpu.regs.WZ = port + 1;
    cpu.regs[dst] = value;
    cpu.updateFlags({
      n: 0,
      pv: parity(value),
      h: 0,
      z: value === 0,
      s: value & 0x80,
      x: value & FLAG_X,
      y: value & FLAG_Y,
    });
  },
});

const io_write_az: MCycle = {
  type: "IOW",
  tStates: 4,
  process: (cpu) => {
    const port: u16 = (cpu.regs.A << 8) | cpu.regs.Z;
    cpu.regs.W = cpu.regs.A;
    cpu.regs.Z++;
    cpu.io.write(port, cpu.regs.A);
  },
};

const io_write_bc = (src: Reg8): MCycle => ({
  type: "IOW",
  tStates: 4,
  process: (cpu) => {
    cpu.io.write(cpu.regs.BC, cpu.regs[src]);
    cpu.regs.WZ = cpu.regs.BC + 1;
  },
});

const mem_read_sp_plus_1_to_w: MCycle = {
  type: "MR",
  tStates: 4,
  process: (cpu) => {
    const addr = asU16(cpu.regs.SP + 1);
    cpu.regs.W = cpu.mem.read(addr);
  },
};

const mem_write_h_to_sp_plus_1 = (set: RegSet): MCycle => ({
  type: "MW",
  tStates: 3,
  process: (cpu) => {
    const addr = asU16(cpu.regs.SP + 1);
    cpu.mem.write(addr, cpu.regs[set.rh]);
  },
});

const mem_write_l_to_sp_transfer_wz = (set: RegSet): MCycle => ({
  type: "MW",
  tStates: 5,
  process: (cpu) => {
    cpu.mem.write(cpu.regs.SP, cpu.regs[set.rl]);
    cpu.regs[set.rp] = cpu.regs.WZ;
  },
});

const ld_sp_hl = (set: RegSet): MCycle => ({
  type: "INT",
  tStates: 2,
  process: (cpu) => (cpu.regs.SP = cpu.regs[set.rp]),
});

function ret(check: MCycle = opcode_fetch) {
  return [
    check,
    mem_read("SP", "Z", inc_sp.process),
    mem_read("SP", "W", inc_sp_goto_wz),
  ];
}

function pop_r16(hi: Reg8, lo: Reg8) {
  return [
    opcode_fetch,
    mem_read("SP", lo, inc_sp.process),
    mem_read("SP", hi, inc_sp.process),
  ];
}
function push_r16(hi: Reg8, lo: Reg8) {
  return [
    opcode_fetch,
    dec_sp,
    mem_write("SP", hi, dec_sp.process),
    mem_write("SP", lo),
  ];
}

function jp(post?: (cpu: Z80, op: u8) => void) {
  return [opcode_fetch_and(post), fetch_z, fetch_w_goto_wz_respect_skip_jump];
}

function call(post?: (cpu: Z80, op: u8) => void) {
  return [
    opcode_fetch_and(post),
    fetch_z,
    fetch_w_respect_skip_jump,
    dec_sp,
    mem_write("SP", "PCH", dec_sp.process),
    mem_write("SP", "PCL", (cpu) => (cpu.regs.PC = cpu.regs.WZ)),
  ];
}

function rst(vector: u16) {
  return [
    opcode_fetch,
    dec_sp,
    mem_write("SP", "PCH", dec_sp.process),
    mem_write("SP", "PCL", (cpu) => {
      cpu.regs.PC = vector;
      cpu.regs.WZ = vector;
    }),
  ];
}

const makeOpTable = (...list: OpCode[]): Record<u8, OpCode> =>
  Object.fromEntries(list.map((op) => [op.code, op]));

export function buildOpTable(set: RegSet): Record<u8, OpCode> {
  // Per-set fetch helpers for the H/L halves of the active register pair.
  const fetch_rh = fetch_r8(set.rh);
  const fetch_rl = fetch_r8(set.rl);
  const inc_rh = opcode_fetch_and_inc_r8(set.rh);
  const dec_rh = opcode_fetch_and_dec_r8(set.rh);
  const inc_rl = opcode_fetch_and_inc_r8(set.rl);
  const dec_rl = opcode_fetch_and_dec_r8(set.rl);

  // prettier-ignore — the per-opcode lines below are deliberately laid
  // out as a table (one row per opcode), which is much more navigable
  // than the multi-line shape prettier would produce.
  // prettier-ignore
  return makeOpTable(
  op(0x00, "NOP", [opcode_fetch]),
  op(0x01, "LD BC,nn", [opcode_fetch, fetch_c, fetch_b]),
  op(0x02, "LD (BC),A", [
    opcode_fetch,
    mem_write("BC", "A", (cpu) => {
      cpu.regs.Z = cpu.regs.C + 1;
      cpu.regs.W = cpu.regs.A;
    }),
  ]),
  op(0x03, "INC BC", [opcode_fetch, inc_r16("BC")]),
  op(0x04, "INC B", [opcode_fetch_and_inc_r8("B")]),
  op(0x05, "DEC B", [opcode_fetch_and_dec_r8("B")]),
  op(0x06, "LD B,n", [opcode_fetch, fetch_b]),
  op(0x07, "RLCA", [opcode_fetch_and(rlca)]),
  op(0x08, "EX AF,AF'", [opcode_fetch_and(ex_af)]),
  op(0x09, `ADD ${set.rp},BC`, [opcode_fetch, add_hl_rr("BC", set)]),
  op(0x0a, "LD A,(BC)", [
    opcode_fetch,
    mem_read("BC", "A", (cpu) => (cpu.regs.WZ = cpu.regs.BC + 1)),
  ]),
  op(0x0b, "DEC BC", [opcode_fetch, dec_r16("BC")]),
  op(0x0c, "INC C", [opcode_fetch_and_inc_r8("C")]),
  op(0x0d, "DEC C", [opcode_fetch_and_dec_r8("C")]),
  op(0x0e, "LD C,n", [opcode_fetch, fetch_c]),
  op(0x0f, "RRCA", [opcode_fetch_and(rrca)]),

  op(0x10, "DJNZ d", [
    opcode_fetch,
    dec_b_set_skip_relative_jump,
    fetch_displacement_respect_skip_jump,
    relative_jump_wz,
  ]),
  op(0x11, "LD DE,nn", [opcode_fetch, fetch_e, fetch_d]),
  op(0x12, "LD (DE),A", [
    opcode_fetch,
    mem_write("DE", "A", (cpu) => {
      cpu.regs.Z = cpu.regs.E + 1;
      cpu.regs.W = cpu.regs.A;
    }),
  ]),
  op(0x13, "INC DE", [opcode_fetch, inc_r16("DE")]),
  op(0x14, "INC D", [opcode_fetch_and_inc_r8("D")]),
  op(0x15, "DEC D", [opcode_fetch_and_dec_r8("D")]),
  op(0x16, "LD D,n", [opcode_fetch, fetch_d]),
  op(0x17, "RLA", [opcode_fetch_and(rla)]),
  op(0x18, "JR d", [
    opcode_fetch,
    fetch_displacement_respect_skip_jump,
    relative_jump_wz,
  ]),
  op(0x19, `ADD ${set.rp},DE`, [opcode_fetch, add_hl_rr("DE", set)]),
  op(0x1a, "LD A,(DE)", [
    opcode_fetch,
    mem_read("DE", "A", (cpu) => (cpu.regs.WZ = cpu.regs.DE + 1)),
  ]),
  op(0x1b, "DEC DE", [opcode_fetch, dec_r16("DE")]),
  op(0x1c, "INC E", [opcode_fetch_and_inc_r8("E")]),
  op(0x1d, "DEC E", [opcode_fetch_and_dec_r8("E")]),
  op(0x1e, "LD E,n", [opcode_fetch, fetch_e]),
  op(0x1f, "RRA", [opcode_fetch_and(rra)]),

  op(0x20, "JR nz,d", [
    opcode_fetch_and(jump_if_flag_not_set(FLAG_Z)),
    fetch_displacement_respect_skip_jump,
    relative_jump_wz,
  ]),
  op(0x21, `LD ${set.rp},nn`, [opcode_fetch, fetch_rl, fetch_rh]),
  op(0x22, `LD (nn),${set.rp}`, [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_write("WZ", set.rl, (cpu) => cpu.regs.WZ++),
    mem_write("WZ", set.rh),
  ]),
  op(0x23, `INC ${set.rp}`, [opcode_fetch, inc_r16(set.rp)]),
  op(0x24, `INC ${set.rh}`, [inc_rh]),
  op(0x25, `DEC ${set.rh}`, [dec_rh]),
  op(0x26, `LD ${set.rh},n`, [opcode_fetch, fetch_rh]),
  op(0x27, "DAA", [opcode_fetch_and(daa)]),
  op(0x28, "JR z,d", [
    opcode_fetch_and(jump_if_flag_set(FLAG_Z)),
    fetch_displacement_respect_skip_jump,
    relative_jump_wz,
  ]),
  op(0x29, `ADD ${set.rp},${set.rp}`, [opcode_fetch, add_hl_rr(set.rp, set)]),
  op(0x2a, `LD ${set.rp},(nn)`, [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_read("WZ", set.rl, (cpu) => cpu.regs.WZ++),
    mem_read("WZ", set.rh),
  ]),
  op(0x2b, `DEC ${set.rp}`, [opcode_fetch, dec_r16(set.rp)]),
  op(0x2c, `INC ${set.rl}`, [inc_rl]),
  op(0x2d, `DEC ${set.rl}`, [dec_rl]),
  op(0x2e, `LD ${set.rl},n`, [opcode_fetch, fetch_rl]),
  op(0x2f, "CPL", [opcode_fetch_and(cpl)]),

  op(0x30, "JR nc,d", [
    opcode_fetch_and(jump_if_flag_not_set(FLAG_C)),
    fetch_displacement_respect_skip_jump,
    relative_jump_wz,
  ]),
  op(0x31, "LD SP,nn", [opcode_fetch, fetch_spl, fetch_sph]),
  op(0x32, "LD (nn),A", [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_write("WZ", "A", (cpu, addr) => {
      cpu.regs.Z = addr + 1;
      cpu.regs.W = cpu.regs.A;
    }),
  ]),
  op(0x33, "INC SP", [opcode_fetch, inc_r16("SP")]),
  op(0x34, `INC (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx"),
    inc_opx,
    mem_write(indexed_addr(set), "OPx"),
  ]),
  op(0x35, `DEC (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx"),
    dec_opx,
    mem_write(indexed_addr(set), "OPx"),
  ]),
  // LD (HL),n: opcode, fetch n, write. LD (IX+d),n: opcode, fetch d, fetch n,
  // 2-cycle pause, write. The disp comes BEFORE n, the delay is shorter than
  // the usual 5 because n's fetch overlaps with the address calculation.
  op(0x36, `LD (${addr_mnemonic(set)}),n`, [
    opcode_fetch,
    ...(set.addr === "hl"
      ? [fetch_opx]
      : [fetch_disp_to_wz(set), fetch_opx, internal_delay(2)]),
    mem_write(indexed_addr(set), "OPx"),
  ]),
  op(0x37, "SCF", [opcode_fetch_and(scf)]),
  op(0x38, "JR c,d", [
    opcode_fetch_and(jump_if_flag_set(FLAG_C)),
    fetch_displacement_respect_skip_jump,
    relative_jump_wz,
  ]),
  op(0x39, `ADD ${set.rp},SP`, [opcode_fetch, add_hl_rr("SP", set)]),
  op(0x3a, "LD A,(nn)", [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_read("WZ", "A", (cpu) => cpu.regs.WZ++),
  ]),
  op(0x3b, "DEC SP", [opcode_fetch, dec_r16("SP")]),
  op(0x3c, "INC A", [opcode_fetch_and_inc_r8("A")]),
  op(0x3d, "DEC A", [opcode_fetch_and_dec_r8("A")]),
  op(0x3e, "LD A,n", [opcode_fetch, fetch_a]),
  op(0x3f, "CCF", [opcode_fetch_and(ccf)]),

  op(0x40, "LD B,B", [opcode_fetch_and_load_r8_from_r8("B", "B")]),
  op(0x41, "LD B,C", [opcode_fetch_and_load_r8_from_r8("B", "C")]),
  op(0x42, "LD B,D", [opcode_fetch_and_load_r8_from_r8("B", "D")]),
  op(0x43, "LD B,E", [opcode_fetch_and_load_r8_from_r8("B", "E")]),
  op(0x44, `LD B,${set.rh}`, [opcode_fetch_and_load_r8_from_r8("B", set.rh)]),
  op(0x45, `LD B,${set.rl}`, [opcode_fetch_and_load_r8_from_r8("B", set.rl)]),
  op(0x46, `LD B,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "B"),
  ]),
  op(0x47, "LD B,A", [opcode_fetch_and_load_r8_from_r8("B", "A")]),
  op(0x48, "LD C,B", [opcode_fetch_and_load_r8_from_r8("C", "B")]),
  op(0x49, "LD C,C", [opcode_fetch_and_load_r8_from_r8("C", "C")]),
  op(0x4a, "LD C,D", [opcode_fetch_and_load_r8_from_r8("C", "D")]),
  op(0x4b, "LD C,E", [opcode_fetch_and_load_r8_from_r8("C", "E")]),
  op(0x4c, `LD C,${set.rh}`, [opcode_fetch_and_load_r8_from_r8("C", set.rh)]),
  op(0x4d, `LD C,${set.rl}`, [opcode_fetch_and_load_r8_from_r8("C", set.rl)]),
  op(0x4e, `LD C,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "C"),
  ]),
  op(0x4f, "LD C,A", [opcode_fetch_and_load_r8_from_r8("C", "A")]),

  op(0x50, "LD D,B", [opcode_fetch_and_load_r8_from_r8("D", "B")]),
  op(0x51, "LD D,C", [opcode_fetch_and_load_r8_from_r8("D", "C")]),
  op(0x52, "LD D,D", [opcode_fetch_and_load_r8_from_r8("D", "D")]),
  op(0x53, "LD D,E", [opcode_fetch_and_load_r8_from_r8("D", "E")]),
  op(0x54, `LD D,${set.rh}`, [opcode_fetch_and_load_r8_from_r8("D", set.rh)]),
  op(0x55, `LD D,${set.rl}`, [opcode_fetch_and_load_r8_from_r8("D", set.rl)]),
  op(0x56, `LD D,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "D"),
  ]),
  op(0x57, "LD D,A", [opcode_fetch_and_load_r8_from_r8("D", "A")]),
  op(0x58, "LD E,B", [opcode_fetch_and_load_r8_from_r8("E", "B")]),
  op(0x59, "LD E,C", [opcode_fetch_and_load_r8_from_r8("E", "C")]),
  op(0x5a, "LD E,D", [opcode_fetch_and_load_r8_from_r8("E", "D")]),
  op(0x5b, "LD E,E", [opcode_fetch_and_load_r8_from_r8("E", "E")]),
  op(0x5c, `LD E,${set.rh}`, [opcode_fetch_and_load_r8_from_r8("E", set.rh)]),
  op(0x5d, `LD E,${set.rl}`, [opcode_fetch_and_load_r8_from_r8("E", set.rl)]),
  op(0x5e, `LD E,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "E"),
  ]),
  op(0x5f, "LD E,A", [opcode_fetch_and_load_r8_from_r8("E", "A")]),

  // 0x60-67: LD H,r — H is destination (swaps to IXH/IYH for indexed sets);
  // 0x66 (LD H,(HL)) keeps H literal because the (HL) memory operand
  // disqualifies the H/L→IXH/IXL substitution per Sean Young.
  op(0x60, `LD ${set.rh},B`, [opcode_fetch_and_load_r8_from_r8(set.rh, "B")]),
  op(0x61, `LD ${set.rh},C`, [opcode_fetch_and_load_r8_from_r8(set.rh, "C")]),
  op(0x62, `LD ${set.rh},D`, [opcode_fetch_and_load_r8_from_r8(set.rh, "D")]),
  op(0x63, `LD ${set.rh},E`, [opcode_fetch_and_load_r8_from_r8(set.rh, "E")]),
  op(0x64, `LD ${set.rh},${set.rh}`, [
    opcode_fetch_and_load_r8_from_r8(set.rh, set.rh),
  ]),
  op(0x65, `LD ${set.rh},${set.rl}`, [
    opcode_fetch_and_load_r8_from_r8(set.rh, set.rl),
  ]),
  op(0x66, `LD H,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "H"),
  ]),
  op(0x67, `LD ${set.rh},A`, [opcode_fetch_and_load_r8_from_r8(set.rh, "A")]),
  op(0x68, `LD ${set.rl},B`, [opcode_fetch_and_load_r8_from_r8(set.rl, "B")]),
  op(0x69, `LD ${set.rl},C`, [opcode_fetch_and_load_r8_from_r8(set.rl, "C")]),
  op(0x6a, `LD ${set.rl},D`, [opcode_fetch_and_load_r8_from_r8(set.rl, "D")]),
  op(0x6b, `LD ${set.rl},E`, [opcode_fetch_and_load_r8_from_r8(set.rl, "E")]),
  op(0x6c, `LD ${set.rl},${set.rh}`, [
    opcode_fetch_and_load_r8_from_r8(set.rl, set.rh),
  ]),
  op(0x6d, `LD ${set.rl},${set.rl}`, [
    opcode_fetch_and_load_r8_from_r8(set.rl, set.rl),
  ]),
  op(0x6e, `LD L,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "L"),
  ]),
  op(0x6f, `LD ${set.rl},A`, [opcode_fetch_and_load_r8_from_r8(set.rl, "A")]),

  // 0x70-77: LD (HL),r — (HL) is the memory operand, so r stays literal
  // (the H/L source registers in 0x74/75 do NOT become IXH/IXL).
  op(0x70, `LD (${addr_mnemonic(set)}),B`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "B"),
  ]),
  op(0x71, `LD (${addr_mnemonic(set)}),C`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "C"),
  ]),
  op(0x72, `LD (${addr_mnemonic(set)}),D`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "D"),
  ]),
  op(0x73, `LD (${addr_mnemonic(set)}),E`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "E"),
  ]),
  op(0x74, `LD (${addr_mnemonic(set)}),H`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "H"),
  ]),
  op(0x75, `LD (${addr_mnemonic(set)}),L`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "L"),
  ]),
  op(0x76, "HALT", [opcode_fetch_and(halt)]),
  op(0x77, `LD (${addr_mnemonic(set)}),A`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_write(indexed_addr(set), "A"),
  ]),
  op(0x78, "LD A,B", [opcode_fetch_and_load_r8_from_r8("A", "B")]),
  op(0x79, "LD A,C", [opcode_fetch_and_load_r8_from_r8("A", "C")]),
  op(0x7a, "LD A,D", [opcode_fetch_and_load_r8_from_r8("A", "D")]),
  op(0x7b, "LD A,E", [opcode_fetch_and_load_r8_from_r8("A", "E")]),
  op(0x7c, `LD A,${set.rh}`, [opcode_fetch_and_load_r8_from_r8("A", set.rh)]),
  op(0x7d, `LD A,${set.rl}`, [opcode_fetch_and_load_r8_from_r8("A", set.rl)]),
  op(0x7e, `LD A,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "A"),
  ]),
  op(0x7f, "LD A,A", [opcode_fetch_and_load_r8_from_r8("A", "A")]),

  op(0x80, "ADD A,B", [opcode_fetch_and(add_a_r8("B", false))]),
  op(0x81, "ADD A,C", [opcode_fetch_and(add_a_r8("C", false))]),
  op(0x82, "ADD A,D", [opcode_fetch_and(add_a_r8("D", false))]),
  op(0x83, "ADD A,E", [opcode_fetch_and(add_a_r8("E", false))]),
  op(0x84, `ADD A,${set.rh}`, [opcode_fetch_and(add_a_r8(set.rh, false))]),
  op(0x85, `ADD A,${set.rl}`, [opcode_fetch_and(add_a_r8(set.rl, false))]),
  op(0x86, `ADD A,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", add_a_r8("OPx", false)),
  ]),
  op(0x87, "ADD A,A", [opcode_fetch_and(add_a_r8("A", false))]),
  op(0x88, "ADC A,B", [opcode_fetch_and(add_a_r8("B", true))]),
  op(0x89, "ADC A,C", [opcode_fetch_and(add_a_r8("C", true))]),
  op(0x8a, "ADC A,D", [opcode_fetch_and(add_a_r8("D", true))]),
  op(0x8b, "ADC A,E", [opcode_fetch_and(add_a_r8("E", true))]),
  op(0x8c, `ADC A,${set.rh}`, [opcode_fetch_and(add_a_r8(set.rh, true))]),
  op(0x8d, `ADC A,${set.rl}`, [opcode_fetch_and(add_a_r8(set.rl, true))]),
  op(0x8e, `ADC A,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", add_a_r8("OPx", true)),
  ]),
  op(0x8f, "ADC A,A", [opcode_fetch_and(add_a_r8("A", true))]),

  op(0x90, "SUB B", [opcode_fetch_and(sub_a_r8("B", false))]),
  op(0x91, "SUB C", [opcode_fetch_and(sub_a_r8("C", false))]),
  op(0x92, "SUB D", [opcode_fetch_and(sub_a_r8("D", false))]),
  op(0x93, "SUB E", [opcode_fetch_and(sub_a_r8("E", false))]),
  op(0x94, `SUB ${set.rh}`, [opcode_fetch_and(sub_a_r8(set.rh, false))]),
  op(0x95, `SUB ${set.rl}`, [opcode_fetch_and(sub_a_r8(set.rl, false))]),
  op(0x96, `SUB (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", sub_a_r8("OPx", false)),
  ]),
  op(0x97, "SUB A", [opcode_fetch_and(sub_a_r8("A", false))]),
  op(0x98, "SBC A,B", [opcode_fetch_and(sub_a_r8("B", true))]),
  op(0x99, "SBC A,C", [opcode_fetch_and(sub_a_r8("C", true))]),
  op(0x9a, "SBC A,D", [opcode_fetch_and(sub_a_r8("D", true))]),
  op(0x9b, "SBC A,E", [opcode_fetch_and(sub_a_r8("E", true))]),
  op(0x9c, `SBC A,${set.rh}`, [opcode_fetch_and(sub_a_r8(set.rh, true))]),
  op(0x9d, `SBC A,${set.rl}`, [opcode_fetch_and(sub_a_r8(set.rl, true))]),
  op(0x9e, `SBC A,(${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", sub_a_r8("OPx", true)),
  ]),
  op(0x9f, "SBC A,A", [opcode_fetch_and(sub_a_r8("A", true))]),

  op(0xa0, "AND B", [opcode_fetch_and(and_a_r8("B"))]),
  op(0xa1, "AND C", [opcode_fetch_and(and_a_r8("C"))]),
  op(0xa2, "AND D", [opcode_fetch_and(and_a_r8("D"))]),
  op(0xa3, "AND E", [opcode_fetch_and(and_a_r8("E"))]),
  op(0xa4, `AND ${set.rh}`, [opcode_fetch_and(and_a_r8(set.rh))]),
  op(0xa5, `AND ${set.rl}`, [opcode_fetch_and(and_a_r8(set.rl))]),
  op(0xa6, `AND (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", and_a_r8("OPx")),
  ]),
  op(0xa7, "AND A", [opcode_fetch_and(and_a_r8("A"))]),
  op(0xa8, "XOR B", [opcode_fetch_and(xor_a_r8("B"))]),
  op(0xa9, "XOR C", [opcode_fetch_and(xor_a_r8("C"))]),
  op(0xaa, "XOR D", [opcode_fetch_and(xor_a_r8("D"))]),
  op(0xab, "XOR E", [opcode_fetch_and(xor_a_r8("E"))]),
  op(0xac, `XOR ${set.rh}`, [opcode_fetch_and(xor_a_r8(set.rh))]),
  op(0xad, `XOR ${set.rl}`, [opcode_fetch_and(xor_a_r8(set.rl))]),
  op(0xae, `XOR (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", xor_a_r8("OPx")),
  ]),
  op(0xaf, "XOR A", [opcode_fetch_and(xor_a_r8("A"))]),

  op(0xb0, "OR B", [opcode_fetch_and(or_a_r8("B"))]),
  op(0xb1, "OR C", [opcode_fetch_and(or_a_r8("C"))]),
  op(0xb2, "OR D", [opcode_fetch_and(or_a_r8("D"))]),
  op(0xb3, "OR E", [opcode_fetch_and(or_a_r8("E"))]),
  op(0xb4, `OR ${set.rh}`, [opcode_fetch_and(or_a_r8(set.rh))]),
  op(0xb5, `OR ${set.rl}`, [opcode_fetch_and(or_a_r8(set.rl))]),
  op(0xb6, `OR (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", or_a_r8("OPx")),
  ]),
  op(0xb7, "OR A", [opcode_fetch_and(or_a_r8("A"))]),
  op(0xb8, "CP B", [opcode_fetch_and(cp_a_r8("B"))]),
  op(0xb9, "CP C", [opcode_fetch_and(cp_a_r8("C"))]),
  op(0xba, "CP D", [opcode_fetch_and(cp_a_r8("D"))]),
  op(0xbb, "CP E", [opcode_fetch_and(cp_a_r8("E"))]),
  op(0xbc, `CP ${set.rh}`, [opcode_fetch_and(cp_a_r8(set.rh))]),
  op(0xbd, `CP ${set.rl}`, [opcode_fetch_and(cp_a_r8(set.rl))]),
  op(0xbe, `CP (${addr_mnemonic(set)})`, [
    opcode_fetch,
    ...indexed_prefix(set),
    mem_read(indexed_addr(set), "OPx", cp_a_r8("OPx")),
  ]),
  op(0xbf, "CP A", [opcode_fetch_and(cp_a_r8("A"))]),

  op(0xc0, "RET nz", ret(opcode_fetch_ret_if_flag_not_set(FLAG_Z))),
  op(0xc1, "POP BC", pop_r16("B", "C")),
  op(0xc2, "JP nz,nn", jp(jump_if_flag_not_set(FLAG_Z))),
  op(0xc3, "JP nn", jp()),
  op(0xc4, "CALL nz,nn", call(jump_if_flag_not_set(FLAG_Z))),
  op(0xc5, "PUSH BC", push_r16("B", "C")),
  op(0xc6, "ADD A,n", [opcode_fetch, fetch_byte(add_a_imm(false))]),
  op(0xc7, "RST 00", rst(0x00)),
  op(0xc8, "RET z", ret(opcode_fetch_ret_if_flag_set(FLAG_Z))),
  op(0xc9, "RET", ret()),
  op(0xca, "JP z,nn", jp(jump_if_flag_set(FLAG_Z))),
  op(0xcb, "PREFIX CB", prefix_cb_for(set)),
  op(0xcc, "CALL z,nn", call(jump_if_flag_set(FLAG_Z))),
  op(0xcd, "CALL nn", call()),
  op(0xce, "ADC A,n", [opcode_fetch, fetch_byte(add_a_imm(true))]),
  op(0xcf, "RST 08", rst(0x08)),

  op(0xd0, "RET nc", ret(opcode_fetch_ret_if_flag_not_set(FLAG_C))),
  op(0xd1, "POP DE", pop_r16("D", "E")),
  op(0xd2, "JP nc,nn", jp(jump_if_flag_not_set(FLAG_C))),
  op(0xd3, "OUT (n),A", [opcode_fetch, fetch_z, io_write_az]),
  op(0xd4, "CALL nc,nn", call(jump_if_flag_not_set(FLAG_C))),
  op(0xd5, "PUSH DE", push_r16("D", "E")),
  op(0xd6, "SUB n", [opcode_fetch, fetch_byte(sub_a_imm(false))]),
  op(0xd7, "RST 10", rst(0x10)),
  op(0xd8, "RET c", ret(opcode_fetch_ret_if_flag_set(FLAG_C))),
  op(0xd9, "EXX", [opcode_fetch_and(exx)]),
  op(0xda, "JP c,nn", jp(jump_if_flag_set(FLAG_C))),
  op(0xdb, "IN A,(n)", [opcode_fetch, fetch_z, io_read_az]),
  op(0xdc, "CALL c,nn", call(jump_if_flag_set(FLAG_C))),
  op(0xdd, "PREFIX DD", [opcode_fetch_and(prefix_dd)]),
  op(0xde, "SBC A,n", [opcode_fetch, fetch_byte(sub_a_imm(true))]),
  op(0xdf, "RST 18", rst(0x18)),

  op(0xe0, "RET po", ret(opcode_fetch_ret_if_flag_not_set(FLAG_PV))),
  op(0xe1, `POP ${set.rp}`, pop_r16(set.rh, set.rl)),
  op(0xe2, "JP po,nn", jp(jump_if_flag_not_set(FLAG_PV))),
  op(0xe3, `EX (SP),${set.rp}`, [
    opcode_fetch,
    mem_read("SP", "Z"),
    mem_read_sp_plus_1_to_w,
    mem_write_h_to_sp_plus_1(set),
    mem_write_l_to_sp_transfer_wz(set),
  ]),
  op(0xe4, "CALL po,nn", call(jump_if_flag_not_set(FLAG_PV))),
  op(0xe5, `PUSH ${set.rp}`, push_r16(set.rh, set.rl)),
  op(0xe6, "AND n", [opcode_fetch, fetch_byte(and_a)]),
  op(0xe7, "RST 20", rst(0x20)),
  op(0xe8, "RET pe", ret(opcode_fetch_ret_if_flag_set(FLAG_PV))),
  op(0xe9, `JP (${set.rp})`, [opcode_fetch_and(jp_hl(set))]),
  op(0xea, "JP pe,nn", jp(jump_if_flag_set(FLAG_PV))),
  op(0xeb, "EX DE,HL", [opcode_fetch_and(ex_de_hl)]),
  op(0xec, "CALL pe,nn", call(jump_if_flag_set(FLAG_PV))),
  op(0xed, "PREFIX ED", [opcode_fetch_and(prefix_ed)]),
  op(0xee, "XOR n", [opcode_fetch, fetch_byte(xor_a)]),
  op(0xef, "RST 28", rst(0x28)),

  op(0xf0, "RET p", ret(opcode_fetch_ret_if_flag_not_set(FLAG_S))),
  op(0xf1, "POP AF", pop_r16("A", "F")),
  op(0xf2, "JP p,nn", jp(jump_if_flag_not_set(FLAG_S))),
  op(0xf3, "DI", [opcode_fetch_and(di)]),
  op(0xf4, "CALL p,nn", call(jump_if_flag_not_set(FLAG_S))),
  op(0xf5, "PUSH AF", push_r16("A", "F")),
  op(0xf6, "OR n", [opcode_fetch, fetch_byte(or_a)]),
  op(0xf7, "RST 30", rst(0x30)),
  op(0xf8, "RET m", ret(opcode_fetch_ret_if_flag_set(FLAG_S))),
  op(0xf9, `LD SP,${set.rp}`, [opcode_fetch, ld_sp_hl(set)]),
  op(0xfa, "JP m,nn", jp(jump_if_flag_set(FLAG_S))),
  op(0xfb, "EI", [opcode_fetch_and(ei)]),
  op(0xfc, "CALL m,nn", call(jump_if_flag_set(FLAG_S))),
  op(0xfd, "PREFIX FD", [opcode_fetch_and(prefix_fd)]),
  op(0xfe, "CP n", [opcode_fetch, fetch_byte(cp_a_imm)]),
  op(0xff, "RST 38", rst(0x38)),
  );
}

export const opCodes = buildOpTable(HL_SET);

const set_im = (value: number) => (cpu: Z80) => (cpu.im = value);

// Helpers for the ED table.
const ld_a_ir = (src: Reg8): MCycle =>
  opcode_fetch_and((cpu) => do_ld_a_ir(cpu, cpu.regs[src]));

const ld_nn_rr = (hi: Reg8, lo: Reg8): OpCode["mCycles"] => [
  opcode_fetch,
  fetch_z,
  fetch_w,
  mem_write("WZ", lo, (cpu) => cpu.regs.WZ++),
  mem_write("WZ", hi),
];

const ld_rr_nn = (hi: Reg8, lo: Reg8): OpCode["mCycles"] => [
  opcode_fetch,
  fetch_z,
  fetch_w,
  mem_read("WZ", lo, (cpu) => cpu.regs.WZ++),
  mem_read("WZ", hi),
];

// LD SP,(nn) / LD (nn),SP — same shape as the rr variants but the register
// pair is exposed as SP/SPH/SPL halves on our regs object.
const ld_nn_sp = (): OpCode["mCycles"] => [
  opcode_fetch,
  fetch_z,
  fetch_w,
  mem_write("WZ", "SPL", (cpu) => cpu.regs.WZ++),
  mem_write("WZ", "SPH"),
];

const ld_sp_nn = (): OpCode["mCycles"] => [
  opcode_fetch,
  fetch_z,
  fetch_w,
  mem_read("WZ", "SPL", (cpu) => cpu.regs.WZ++),
  mem_read("WZ", "SPH"),
];

const im = (mode: number) => [opcode_fetch_and(set_im(mode))];

// RETN and RETI both restore IFF1 from IFF2 on real silicon (per
// SingleStepTests / Patrik Rak's hardware tracing) — older docs say only
// RETN does this, but real chips behave the same.
const retn_setup = opcode_fetch_and((cpu) => {
  cpu.iff1 = cpu.iff2;
});

const ed_nop: OpCode["mCycles"] = [opcode_fetch];

// IN F,(C) / IN (C) — read from port BC, set flags from the value, but
// don't write the result anywhere.
const in_f_bc: MCycle = {
  type: "IOR",
  tStates: 4,
  process: (cpu) => {
    const port = cpu.regs.BC;
    const value = cpu.io.read(port);
    cpu.regs.WZ = port + 1;
    cpu.updateFlags({
      n: 0,
      pv: parity(value),
      h: 0,
      z: value === 0,
      s: value & 0x80,
      x: value & FLAG_X,
      y: value & FLAG_Y,
    });
  },
};

// OUT (C),0 — write 0 to port BC. Real NMOS Z80 writes 0xff here (some
// docs); CMOS revisions write 0. SR-class machines are CMOS so use 0.
const out_bc_0: MCycle = {
  type: "IOW",
  tStates: 4,
  process: (cpu) => {
    const port = cpu.regs.BC;
    cpu.io.write(port, 0);
    cpu.regs.WZ = port + 1;
  },
};

// Block transfer: LDI = transfer one byte HL→DE, advance HL/DE, decrement BC.
// LDD reverses HL/DE direction. The repeating LDIR/LDDR re-execute the same
// instruction (PC -= 2) until BC reaches 0; the test data captures this by
// expecting PC unchanged when BC > 0 after the iteration.
const block_ld = (delta: 1 | -1, repeat: boolean): OpCode["mCycles"] => [
  opcode_fetch,
  mem_read("HL", "OPx"),
  mem_write("DE", "OPx", (cpu) => {
    cpu.regs.HL = (cpu.regs.HL + delta) & 0xffff;
    cpu.regs.DE = (cpu.regs.DE + delta) & 0xffff;
    cpu.regs.BC = (cpu.regs.BC - 1) & 0xffff;
    const repeating = repeat && cpu.regs.BC !== 0;
    if (repeating) {
      cpu.regs.PC = (cpu.regs.PC - 2) & 0xffff;
      cpu.regs.WZ = (cpu.regs.PC + 1) & 0xffff;
    }
    do_ld_block(cpu, cpu.regs.OPx, repeating);
  }),
];

const block_cp = (delta: 1 | -1, repeat: boolean): OpCode["mCycles"] => [
  opcode_fetch,
  mem_read("HL", "OPx", (cpu) => {
    cpu.regs.BC = (cpu.regs.BC - 1) & 0xffff;
    const a = cpu.regs.A;
    const value = cpu.regs.OPx;
    const result = (a - value) & 0xff;
    cpu.regs.HL = (cpu.regs.HL + delta) & 0xffff;
    cpu.regs.WZ = (cpu.regs.WZ + delta) & 0xffff;
    const repeating = repeat && cpu.regs.BC !== 0 && result !== 0;
    if (repeating) {
      cpu.regs.PC = (cpu.regs.PC - 2) & 0xffff;
      cpu.regs.WZ = (cpu.regs.PC + 1) & 0xffff;
    }
    do_cp_block(cpu, value, repeating);
  }),
];

// I/O block input. INI: read port BC, write to (HL). HL++. B--. Flags use
// the post-decrement B and a "base" computed as ((C±1) & 0xff) + value.
// IND uses (C-1); INI uses (C+1). The repeating versions (INIR/INDR) loop
// while B != 0 (after decrement).
const block_in = (delta: 1 | -1, repeat: boolean): OpCode["mCycles"] => {
  return [
    opcode_fetch,
    {
      type: "IOR",
      tStates: 4,
      process: (cpu) => {
        const port = cpu.regs.BC;
        cpu.regs.OPx = cpu.io.read(port);
        cpu.regs.WZ = (port + delta) & 0xffff;
      },
    },
    mem_write("HL", "OPx", (cpu) => {
      cpu.regs.HL = (cpu.regs.HL + delta) & 0xffff;
      cpu.regs.B = (cpu.regs.B - 1) & 0xff;
      const base = ((cpu.regs.C + delta) & 0xff) + cpu.regs.OPx;
      const repeating = repeat && cpu.regs.B !== 0;
      if (repeating) {
        cpu.regs.PC = (cpu.regs.PC - 2) & 0xffff;
        cpu.regs.WZ = (cpu.regs.PC + 1) & 0xffff;
      }
      do_io_block_flags(cpu, cpu.regs.OPx, base, repeating);
    }),
  ];
};

// I/O block output. OUTI: read (HL), B--, output to port BC (post-decrement
// B drives the address). HL++. WZ = BC + 1 (with post-decrement B). Base
// for the flag computation is L + value.
const block_out = (delta: 1 | -1, repeat: boolean): OpCode["mCycles"] => [
  opcode_fetch,
  mem_read("HL", "OPx", (cpu) => {
    cpu.regs.B = (cpu.regs.B - 1) & 0xff;
  }),
  {
    type: "IOW",
    tStates: 4,
    process: (cpu) => {
      const port = cpu.regs.BC;
      cpu.io.write(port, cpu.regs.OPx);
      cpu.regs.HL = (cpu.regs.HL + delta) & 0xffff;
      cpu.regs.WZ = (port + delta) & 0xffff;
      const base = (cpu.regs.L + cpu.regs.OPx) & 0x1ff;
      const repeating = repeat && cpu.regs.B !== 0;
      if (repeating) {
        cpu.regs.PC = (cpu.regs.PC - 2) & 0xffff;
        cpu.regs.WZ = (cpu.regs.PC + 1) & 0xffff;
      }
      do_io_block_flags(cpu, cpu.regs.OPx, base, repeating);
    },
  },
];

// RRD / RLD: read (HL), compute new A and new (HL) byte (do_rrd/do_rld
// places the new memory byte in OPx), then write OPx back to (HL).
const rrd_rld = (fn: (cpu: Z80, value: u8) => void): OpCode["mCycles"] => [
  opcode_fetch,
  mem_read("HL", "OPx", (cpu) => fn(cpu, cpu.regs.OPx)),
  mem_write("HL", "OPx"),
];

// prettier-ignore
export const edOpCodes = makeOpTable(
  // 0x40-0x4F
  op(0x40, "IN B,(C)", [opcode_fetch, io_read_bc("B")]),
  op(0x41, "OUT (C),B", [opcode_fetch, io_write_bc("B")]),
  op(0x42, "SBC HL,BC", [opcode_fetch, sbc_hl_rr("BC")]),
  op(0x43, "LD (nn),BC", ld_nn_rr("B", "C")),
  op(0x44, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x45, "RETN", ret(retn_setup)),
  op(0x46, "IM 0", im(0)),
  op(0x47, "LD I,A", [opcode_fetch_and_load_r8_from_r8("I", "A")]),
  op(0x48, "IN C,(C)", [opcode_fetch, io_read_bc("C")]),
  op(0x49, "OUT (C),C", [opcode_fetch, io_write_bc("C")]),
  op(0x4a, "ADC HL,BC", [opcode_fetch, adc_hl_rr("BC")]),
  op(0x4b, "LD BC,(nn)", ld_rr_nn("B", "C")),
  op(0x4c, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x4d, "RETI", ret(retn_setup)),
  op(0x4e, "IM 0/1", im(0)),
  op(0x4f, "LD R,A", [opcode_fetch_and_load_r8_from_r8("R", "A")]),

  // 0x50-0x5F
  op(0x50, "IN D,(C)", [opcode_fetch, io_read_bc("D")]),
  op(0x51, "OUT (C),D", [opcode_fetch, io_write_bc("D")]),
  op(0x52, "SBC HL,DE", [opcode_fetch, sbc_hl_rr("DE")]),
  op(0x53, "LD (nn),DE", ld_nn_rr("D", "E")),
  op(0x54, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x55, "RETN", ret(retn_setup)),
  op(0x56, "IM 1", im(1)),
  op(0x57, "LD A,I", [ld_a_ir("I")]),
  op(0x58, "IN E,(C)", [opcode_fetch, io_read_bc("E")]),
  op(0x59, "OUT (C),E", [opcode_fetch, io_write_bc("E")]),
  op(0x5a, "ADC HL,DE", [opcode_fetch, adc_hl_rr("DE")]),
  op(0x5b, "LD DE,(nn)", ld_rr_nn("D", "E")),
  op(0x5c, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x5d, "RETN", ret(retn_setup)),
  op(0x5e, "IM 2", im(2)),
  op(0x5f, "LD A,R", [ld_a_ir("R")]),

  // 0x60-0x6F
  op(0x60, "IN H,(C)", [opcode_fetch, io_read_bc("H")]),
  op(0x61, "OUT (C),H", [opcode_fetch, io_write_bc("H")]),
  op(0x62, "SBC HL,HL", [opcode_fetch, sbc_hl_rr("HL")]),
  op(0x63, "LD (nn),HL", ld_nn_rr("H", "L")),
  op(0x64, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x65, "RETN", ret(retn_setup)),
  op(0x66, "IM 0", im(0)),
  op(0x67, "RRD", rrd_rld(do_rrd)),
  op(0x68, "IN L,(C)", [opcode_fetch, io_read_bc("L")]),
  op(0x69, "OUT (C),L", [opcode_fetch, io_write_bc("L")]),
  op(0x6a, "ADC HL,HL", [opcode_fetch, adc_hl_rr("HL")]),
  op(0x6b, "LD HL,(nn)", ld_rr_nn("H", "L")),
  op(0x6c, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x6d, "RETN", ret(retn_setup)),
  op(0x6e, "IM 0/1", im(0)),
  op(0x6f, "RLD", rrd_rld(do_rld)),

  // 0x70-0x7F
  op(0x70, "IN F,(C)", [opcode_fetch, in_f_bc]),
  op(0x71, "OUT (C),0", [opcode_fetch, out_bc_0]),
  op(0x72, "SBC HL,SP", [opcode_fetch, sbc_hl_rr("SP")]),
  op(0x73, "LD (nn),SP", ld_nn_sp()),
  op(0x74, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x75, "RETN", ret(retn_setup)),
  op(0x76, "IM 1", im(1)),
  op(0x77, "NOP", ed_nop),
  op(0x78, "IN A,(C)", [opcode_fetch, io_read_bc("A")]),
  op(0x79, "OUT (C),A", [opcode_fetch, io_write_bc("A")]),
  op(0x7a, "ADC HL,SP", [opcode_fetch, adc_hl_rr("SP")]),
  op(0x7b, "LD SP,(nn)", ld_sp_nn()),
  op(0x7c, "NEG", [opcode_fetch_and(do_neg)]),
  op(0x7d, "RETN", ret(retn_setup)),
  op(0x7e, "IM 2", im(2)),
  op(0x7f, "NOP", ed_nop),

  // Block ops (0xA0-0xA3, 0xA8-0xAB, 0xB0-0xB3, 0xB8-0xBB)
  op(0xa0, "LDI", block_ld(1, false)),
  op(0xa1, "CPI", block_cp(1, false)),
  op(0xa2, "INI", block_in(1, false)),
  op(0xa3, "OUTI", block_out(1, false)),
  op(0xa8, "LDD", block_ld(-1, false)),
  op(0xa9, "CPD", block_cp(-1, false)),
  op(0xaa, "IND", block_in(-1, false)),
  op(0xab, "OUTD", block_out(-1, false)),
  op(0xb0, "LDIR", block_ld(1, true)),
  op(0xb1, "CPIR", block_cp(1, true)),
  op(0xb2, "INIR", block_in(1, true)),
  op(0xb3, "OTIR", block_out(1, true)),
  op(0xb8, "LDDR", block_ld(-1, true)),
  op(0xb9, "CPDR", block_cp(-1, true)),
  op(0xba, "INDR", block_in(-1, true)),
  op(0xbb, "OTDR", block_out(-1, true)),
);

// CB-prefixed opcode generation. The 256 ops divide into four groups by the
// upper two bits: rotates/shifts (0x00–0x3f), BIT (0x40–0x7f), RES (0x80–
// 0xbf), SET (0xc0–0xff). Each group has 8 sub-ops × 8 targets where the
// target is B/C/D/E/H/L/(HL)/A indexed by op & 7.

type CbOp = (cpu: Z80, value: u8) => u8;

function setShiftFlags(cpu: Z80, result: u8, carry: number) {
  cpu.updateFlags({
    c: carry,
    n: 0,
    pv: parity(result),
    h: 0,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

const cb_rlc: CbOp = (cpu, v) => {
  const c = (v >> 7) & 1;
  const result = ((v << 1) | c) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const cb_rrc: CbOp = (cpu, v) => {
  const c = v & 1;
  const result = ((v >> 1) | (c << 7)) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const cb_rl: CbOp = (cpu, v) => {
  const carryIn = cpu.regs.F & FLAG_C ? 1 : 0;
  const c = (v >> 7) & 1;
  const result = ((v << 1) | carryIn) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const cb_rr: CbOp = (cpu, v) => {
  const carryIn = cpu.regs.F & FLAG_C ? 0x80 : 0;
  const c = v & 1;
  const result = ((v >> 1) | carryIn) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const cb_sla: CbOp = (cpu, v) => {
  const c = (v >> 7) & 1;
  const result = (v << 1) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const cb_sra: CbOp = (cpu, v) => {
  const c = v & 1;
  const result = ((v >> 1) | (v & 0x80)) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

// Undocumented: Shift Left Logical (also called SLI/SLS). Bit 0 is set to 1
// instead of cleared. Real software occasionally relies on this.
const cb_sll: CbOp = (cpu, v) => {
  const c = (v >> 7) & 1;
  const result = ((v << 1) | 1) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const cb_srl: CbOp = (cpu, v) => {
  const c = v & 1;
  const result = (v >> 1) & 0xff;
  setShiftFlags(cpu, result, c);
  return result;
};

const CB_OPS: ReadonlyArray<CbOp> = [
  cb_rlc,
  cb_rrc,
  cb_rl,
  cb_rr,
  cb_sla,
  cb_sra,
  cb_sll,
  cb_srl,
];
const CB_OP_NAMES = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"];

// Targets at offset 0..7 in any CB row. Slot 6 is (HL) — null marks it so
// the generator dispatches to the indirect path.
const CB_TARGETS: ReadonlyArray<Reg8 | null> = [
  "B",
  "C",
  "D",
  "E",
  "H",
  "L",
  null,
  "A",
];

function setBitFlagsFromValue(cpu: Z80, bit: number, value: u8) {
  const isSet = (value & (1 << bit)) !== 0;
  cpu.updateFlags({
    n: 0,
    pv: !isSet,
    h: 1,
    z: !isSet,
    s: bit === 7 && isSet ? 1 : 0,
    x: value & FLAG_X,
    y: value & FLAG_Y,
  });
}

// BIT b,(HL) takes its X/Y bits from W (the high half of WZ), not from the
// fetched memory byte. For DDCB/FDCB the prefix has already loaded WZ with
// IX/IY+d, so W is the high byte of that address.
function setBitFlagsFromIndirect(cpu: Z80, bit: number, value: u8) {
  const isSet = (value & (1 << bit)) !== 0;
  cpu.updateFlags({
    n: 0,
    pv: !isSet,
    h: 1,
    z: !isSet,
    s: bit === 7 && isSet ? 1 : 0,
    x: cpu.regs.W & FLAG_X,
    y: cpu.regs.W & FLAG_Y,
  });
}

function modify_opx(operation: (cpu: Z80) => void): MCycle {
  return { type: "INT", tStates: 1, process: operation };
}

export function buildCbTable(set: RegSet): Record<u8, OpCode> {
  const ops: OpCode[] = [];
  const addr = indexed_addr(set);
  const addrName = addr_mnemonic(set);

  for (let code = 0; code < 256; code++) {
    const target = code & 7;
    const reg = CB_TARGETS[target];

    if (code < 0x40) {
      // Rotate / shift
      const opIdx = code >> 3;
      const operation = CB_OPS[opIdx]!;
      const opName = CB_OP_NAMES[opIdx];

      if (reg) {
        ops.push(
          op(code, `${opName} ${reg}`, [
            opcode_fetch_and((cpu) => {
              cpu.regs[reg] = operation(cpu, cpu.regs[reg]);
            }),
          ]),
        );
      } else {
        ops.push(
          op(code, `${opName} (${addrName})`, [
            opcode_fetch,
            ...indexed_prefix(set),
            mem_read(addr, "OPx"),
            modify_opx((cpu) => {
              cpu.regs.OPx = operation(cpu, cpu.regs.OPx);
            }),
            mem_write(addr, "OPx"),
          ]),
        );
      }
    } else if (code < 0x80) {
      // BIT b,target
      const bit = (code >> 3) & 7;

      if (reg) {
        ops.push(
          op(code, `BIT ${bit},${reg}`, [
            opcode_fetch_and((cpu) => {
              setBitFlagsFromValue(cpu, bit, cpu.regs[reg]);
            }),
          ]),
        );
      } else {
        ops.push(
          op(code, `BIT ${bit},(${addrName})`, [
            opcode_fetch,
            ...indexed_prefix(set),
            mem_read(addr, "OPx", (cpu) => {
              setBitFlagsFromIndirect(cpu, bit, cpu.regs.OPx);
            }),
          ]),
        );
      }
    } else if (code < 0xc0) {
      // RES b,target
      const bit = (code >> 3) & 7;
      const mask = ~(1 << bit) & 0xff;

      if (reg) {
        ops.push(
          op(code, `RES ${bit},${reg}`, [
            opcode_fetch_and((cpu) => {
              cpu.regs[reg] = cpu.regs[reg] & mask;
            }),
          ]),
        );
      } else {
        ops.push(
          op(code, `RES ${bit},(${addrName})`, [
            opcode_fetch,
            ...indexed_prefix(set),
            mem_read(addr, "OPx"),
            modify_opx((cpu) => {
              cpu.regs.OPx = cpu.regs.OPx & mask;
            }),
            mem_write(addr, "OPx"),
          ]),
        );
      }
    } else {
      // SET b,target
      const bit = (code >> 3) & 7;
      const mask = 1 << bit;

      if (reg) {
        ops.push(
          op(code, `SET ${bit},${reg}`, [
            opcode_fetch_and((cpu) => {
              cpu.regs[reg] = cpu.regs[reg] | mask;
            }),
          ]),
        );
      } else {
        ops.push(
          op(code, `SET ${bit},(${addrName})`, [
            opcode_fetch,
            ...indexed_prefix(set),
            mem_read(addr, "OPx"),
            modify_opx((cpu) => {
              cpu.regs.OPx = cpu.regs.OPx | mask;
            }),
            mem_write(addr, "OPx"),
          ]),
        );
      }
    }
  }

  return makeOpTable(...ops);
}

// DDCB / FDCB ops always operate on (IX+d) / (IY+d). The displacement and
// effective address (in WZ) were established by the DD/FD CB-prefix
// transition before this table is consulted. The op byte itself is fetched
// as MR in real hardware, so the first MCycle is a no-op rather than
// opcode_fetch_and (no R increment, no t-state cost — runOneOp already
// read the byte into OP).
//
// Non-(HL) target slots (0..5, 7) carry an undocumented "register copy"
// side effect: the modified value is also written into the named register.
// BIT b ignores the target slot entirely — every slot behaves identically
// as BIT b,(IX+d) with no register write-back.
export function buildIndexedCbTable(set: RegSet): Record<u8, OpCode> {
  if (set.addr === "hl") {
    throw new Error("buildIndexedCbTable requires an indexed RegSet");
  }
  const ops: OpCode[] = [];
  const rp = set.rp;
  const dispatch: MCycle = { type: "INT", tStates: 0, process: () => {} };
  const copy_opx_to = (reg: Reg8): MCycle => ({
    type: "INT",
    tStates: 0,
    process: (cpu) => {
      cpu.regs[reg] = cpu.regs.OPx;
    },
  });

  for (let code = 0; code < 256; code++) {
    const target = code & 7;
    const reg = CB_TARGETS[target];
    const regSuffix = reg ? `,${reg}` : "";

    if (code < 0x40) {
      const opIdx = code >> 3;
      const operation = CB_OPS[opIdx]!;
      const opName = CB_OP_NAMES[opIdx];
      const cycles: MCycle[] = [
        dispatch,
        mem_read("WZ", "OPx"),
        modify_opx((cpu) => {
          cpu.regs.OPx = operation(cpu, cpu.regs.OPx);
        }),
        mem_write("WZ", "OPx"),
      ];
      if (reg) cycles.push(copy_opx_to(reg));
      ops.push(op(code, `${opName} (${rp}+d)${regSuffix}`, cycles));
    } else if (code < 0x80) {
      // BIT b,(IX+d): same flag set regardless of target slot, no register
      // write. X/Y come from W (the high byte of WZ = IX+d).
      const bit = (code >> 3) & 7;
      ops.push(
        op(code, `BIT ${bit},(${rp}+d)`, [
          dispatch,
          mem_read("WZ", "OPx", (cpu) => {
            setBitFlagsFromIndirect(cpu, bit, cpu.regs.OPx);
          }),
        ]),
      );
    } else if (code < 0xc0) {
      const bit = (code >> 3) & 7;
      const mask = ~(1 << bit) & 0xff;
      const cycles: MCycle[] = [
        dispatch,
        mem_read("WZ", "OPx"),
        modify_opx((cpu) => {
          cpu.regs.OPx = cpu.regs.OPx & mask;
        }),
        mem_write("WZ", "OPx"),
      ];
      if (reg) cycles.push(copy_opx_to(reg));
      ops.push(op(code, `RES ${bit},(${rp}+d)${regSuffix}`, cycles));
    } else {
      const bit = (code >> 3) & 7;
      const mask = 1 << bit;
      const cycles: MCycle[] = [
        dispatch,
        mem_read("WZ", "OPx"),
        modify_opx((cpu) => {
          cpu.regs.OPx = cpu.regs.OPx | mask;
        }),
        mem_write("WZ", "OPx"),
      ];
      if (reg) cycles.push(copy_opx_to(reg));
      ops.push(op(code, `SET ${bit},(${rp}+d)${regSuffix}`, cycles));
    }
  }

  return makeOpTable(...ops);
}

export const cbOpCodes = buildCbTable(HL_SET);

export const ddOpCodes = buildOpTable(IX_SET);

export const ddCbOpCodes = buildIndexedCbTable(IX_SET);

export const fdOpCodes = buildOpTable(IY_SET);

export const fdCbOpCodes = buildIndexedCbTable(IY_SET);
