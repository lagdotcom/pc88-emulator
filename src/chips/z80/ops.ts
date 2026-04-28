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
}

export interface OpCode {
  code: u8;
  mnemonic: string;
  mCycles: MCycle[];
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
});

const opcode_fetch_and = (
  post?: (cpu: Z80, op: u8) => void,
  tStates = 4,
): MCycle => ({
  type: "M1",
  tStates,
  process: (cpu) => {
    if (cpu.mCycleIndex > 0) cpu.regs.OP = cpu.mem.read(cpu.regs.PC++);

    cpu.incR();
    post?.(cpu, cpu.regs.OP);
  },
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
const fetch_h = fetch_r8("H");
const fetch_l = fetch_r8("L");
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

function do_add_a(cpu: Z80, value: u8, useCarry: boolean) {
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

function do_sub_a(cpu: Z80, value: u8, useCarry: boolean) {
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

function do_cp_a(cpu: Z80, value: u8) {
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

function inc8(cpu: Z80, old: u8): u8 {
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

function dec8(cpu: Z80, old: u8): u8 {
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

function do_add16(cpu: Z80, dst: Reg16, value: u16) {
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

function rla(cpu: Z80) {
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

function rlca(cpu: Z80) {
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

function rra(cpu: Z80) {
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

function rrca(cpu: Z80) {
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

function ex_af(cpu: Z80) {
  exchange_regs(cpu, "AF", "AF_");
}

function cpl(cpu: Z80) {
  cpu.regs.A = ~cpu.regs.A;
  cpu.updateFlags({
    n: 1,
    h: 1,
    x: cpu.regs.A & FLAG_X,
    y: cpu.regs.A & FLAG_Y,
  });
}

function daa(cpu: Z80) {
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

function scf(cpu: Z80) {
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

function ccf(cpu: Z80) {
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

function halt(cpu: Z80) {
  cpu.halted = true;
  // now we wait until an interrupt is handled, then do cpu.regs.PC++
}

const jp_hl =
  (set: RegSet) =>
  (cpu: Z80): void => {
    cpu.regs.PC = cpu.regs[set.rp];
  };

function di(cpu: Z80) {
  cpu.iff1 = false;
  cpu.iff2 = false;
  cpu.eiDelay = false;
}

function ei(cpu: Z80) {
  cpu.iff1 = true;
  cpu.iff2 = true;
  cpu.eiDelay = true;
}

function exx(cpu: Z80) {
  exchange_regs(cpu, "BC", "BC_");
  exchange_regs(cpu, "DE", "DE_");
  exchange_regs(cpu, "HL", "HL_");
}

// EX DE,HL is unaffected by DD/FD prefixes — it always swaps DE with HL,
// not IX/IY. (Sean Young, "The Undocumented Z80 Documented".)
function ex_de_hl(cpu: Z80) {
  exchange_regs(cpu, "DE", "HL");
}

function prefix_ed(cpu: Z80) {
  cpu.prefix = { type: "ED" };
}

function prefix_dd(cpu: Z80) {
  cpu.prefix = { type: "DD" };
}

function prefix_fd(cpu: Z80) {
  cpu.prefix = { type: "FD" };
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

const fetch_displacement_respect_skip_jump = fetch_byte((cpu, data) => {
  if (cpu.regs.OPx === skip_jump) {
    cpu.mCycleIndex = Infinity;
    cpu.regs.OPx = no_op;
    return;
  }
  cpu.regs.WZ = asU16(asS8(data));
});

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

const opcode_fetch_ret_if_flag_set = (flag: u8) =>
  opcode_fetch_and((cpu) => {
    if (!(cpu.regs.F & flag)) cpu.mCycleIndex = Infinity;
  }, 5);
const opcode_fetch_ret_if_flag_not_set = (flag: u8) =>
  opcode_fetch_and((cpu) => {
    if (cpu.regs.F & flag) cpu.mCycleIndex = Infinity;
  }, 5);

const fetch_w_goto_wz_respect_skip_jump = fetch_byte((cpu, data) => {
  cpu.regs.W = data;
  if (cpu.regs.OPx === skip_jump) {
    cpu.mCycleIndex = Infinity;
    cpu.regs.OPx = no_op;
  } else cpu.regs.PC = cpu.regs.WZ;
});

const fetch_w_respect_skip_jump = fetch_byte((cpu, data) => {
  cpu.regs.W = data;
  if (cpu.regs.OPx === skip_jump) {
    cpu.mCycleIndex = Infinity;
    cpu.regs.OPx = no_op;
  }
});

const add_a_r8 = (src: Reg8, useCarry: boolean) => (cpu: Z80) =>
  do_add_a(cpu, cpu.regs[src], useCarry);

const add_a_imm =
  (useCarry: boolean) => (cpu: Z80, data: u8) =>
    do_add_a(cpu, data, useCarry);

const sub_a_r8 = (src: Reg8, useCarry: boolean) => (cpu: Z80) =>
  do_sub_a(cpu, cpu.regs[src], useCarry);

const sub_a_imm =
  (useCarry: boolean) => (cpu: Z80, data: u8) =>
    do_sub_a(cpu, data, useCarry);

const cp_a_r8 = (src: Reg8) => (cpu: Z80) => do_cp_a(cpu, cpu.regs[src]);

const cp_a_imm = (cpu: Z80, data: u8) => do_cp_a(cpu, data);

function and_a(cpu: Z80, value: u8) {
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

function or_a(cpu: Z80, value: u8) {
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

function xor_a(cpu: Z80, value: u8) {
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
  // 0xcb: bit ops
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

export const edOpCodes = makeOpTable(
  op(0x40, "IN B,(C)", [opcode_fetch, io_read_bc("B")]),
  op(0x41, "OUT (C),B", [opcode_fetch, io_write_bc("B")]),
  op(0x43, "LD (nn),BC", [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_write("WZ", "C", (cpu) => cpu.regs.WZ++),
    mem_write("WZ", "B"),
  ]),
  op(0x46, "IM 0", [opcode_fetch_and(set_im(0))]),
  op(0x48, "IN C,(C)", [opcode_fetch, io_read_bc("C")]),
  op(0x49, "OUT (C),C", [opcode_fetch, io_write_bc("C")]),
  op(0x4f, "LD R,A", [opcode_fetch_and_load_r8_from_r8("R", "A")]),

  op(0x50, "IN D,(C)", [opcode_fetch, io_read_bc("D")]),
  op(0x51, "OUT (C),D", [opcode_fetch, io_write_bc("D")]),
  op(0x53, "LD (nn),DE", [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_write("WZ", "E", (cpu) => cpu.regs.WZ++),
    mem_write("WZ", "D"),
  ]),
  op(0x56, "IM 1", [opcode_fetch_and(set_im(1))]),
  op(0x58, "IN E,(C)", [opcode_fetch, io_read_bc("E")]),
  op(0x59, "OUT (C),E", [opcode_fetch, io_write_bc("E")]),
  op(0x5e, "IM 2", [opcode_fetch_and(set_im(2))]),
  op(0x5f, "LD A,R", [
    opcode_fetch_and((cpu) => {
      const value = cpu.regs.R;
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
    }),
  ]),

  op(0x60, "IN H,(C)", [opcode_fetch, io_read_bc("H")]),
  op(0x61, "OUT (C),H", [opcode_fetch, io_write_bc("H")]),
  op(0x63, "LD (nn),HL", [
    opcode_fetch,
    fetch_z,
    fetch_w,
    mem_write("WZ", "L", (cpu) => cpu.regs.WZ++),
    mem_write("WZ", "H"),
  ]),
  op(0x68, "IN L,(C)", [opcode_fetch, io_read_bc("L")]),
  op(0x69, "OUT (C),L", [opcode_fetch, io_write_bc("L")]),
);

export const cbOpCodes = makeOpTable();

export const ddOpCodes = buildOpTable(IX_SET);

export const ddcbOpCodes = makeOpTable();

export const fdOpCodes = buildOpTable(IY_SET);

export const fdcbOpCodes = makeOpTable();
