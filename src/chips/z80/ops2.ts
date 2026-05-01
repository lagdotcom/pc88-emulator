// Demonstration of the giant-switch dispatcher pattern for the base
// (unprefixed) opcode table. Single function, one case per opcode,
// register and memory accesses inlined directly. No MCycle objects, no
// closures, no execute() indirect call. Built to compare against
// ops.ts's table-driven dispatch and to serve as the template for
// extending the same pattern to ED/CB/DD/FD/DDCB/FDCB.
//
// runOneOp() in cpu.ts already handles the universal M1 work (fetch
// OP, advance PC, incR, charge 4 t-states) before invoking the
// dispatcher, so cases here only do the per-opcode work and add the
// remaining t-states.
//
// Helpers (do_add_a, inc8, etc.) are imported from ops.ts so the flag
// behaviour stays in one place. The factor of speedup over the table
// path comes from the absence of:
//
//   - the `inst.execute(this)` indirect call,
//   - the closure layer wrapping each MCycle's process function, and
//   - the per-cycle abort check in the abortable variants.
//
// Switch density matters: V8 compiles a 256-case switch on a small
// integer to a jump table (one indirect branch + computed goto),
// which is faster than the chain of comparisons it would emit for
// the peephole switch in cpu.ts.
//
// The conditional jump/call/return cases (JP cc, CALL cc, RET cc,
// JR cc) read the F flag inline. JR-not-taken still has to fetch
// the displacement byte (an MR cycle); CALL-not-taken still has to
// fetch both bytes of the target address.

import type { u8 } from "../../flavours.js";
import { asS8, parity } from "../../numbers.js";
import type { Z80 } from "./cpu.js";
import {
  and_a,
  ccf,
  cpl,
  daa,
  dec8,
  di,
  do_adc_hl,
  do_add_a,
  do_add16,
  do_cp_a,
  do_cp_block,
  do_io_block_flags,
  do_ld_a_ir,
  do_ld_block,
  do_neg,
  do_rld,
  do_rrd,
  do_sbc_hl,
  do_sub_a,
  ei,
  ex_af,
  ex_de_hl,
  exx,
  inc8,
  or_a,
  prefix_cb,
  prefix_dd,
  prefix_ed,
  prefix_fd,
  rla,
  rlca,
  rra,
  rrca,
  scf,
  xor_a,
} from "./alu.js";
import { FLAG_C, FLAG_PV, FLAG_S, FLAG_X, FLAG_Y, FLAG_Z } from "./regs.js";

// Local helper for the JR/JR cc displacement step. Returns the new PC
// after the jump (already includes the displacement-fetch advance) and
// also writes WZ. Caller adds the 5 extra t-states for the taken case.
function jrTaken(cpu: Z80, d: number): void {
  const target = (cpu.regs.PC + asS8(d)) & 0xffff;
  cpu.regs.WZ = target;
  cpu.regs.PC = target;
}

// Push 16 bits big-endian-of-the-pair onto the stack (real Z80 pushes
// high byte first). Used by CALL and PUSH.
function push16(cpu: Z80, value: number): void {
  let sp = cpu.regs.SP;
  sp = (sp - 1) & 0xffff;
  cpu.mem.write(sp, (value >> 8) & 0xff);
  sp = (sp - 1) & 0xffff;
  cpu.mem.write(sp, value & 0xff);
  cpu.regs.SP = sp;
}

function pop16(cpu: Z80): number {
  let sp = cpu.regs.SP;
  const lo = cpu.mem.read(sp);
  sp = (sp + 1) & 0xffff;
  const hi = cpu.mem.read(sp);
  cpu.regs.SP = (sp + 1) & 0xffff;
  return (hi << 8) | lo;
}

// Fetch a 16-bit immediate at PC (low byte first), advancing PC by 2
// and storing the value in WZ.
function fetchNN(cpu: Z80): number {
  const pc = cpu.regs.PC;
  const lo = cpu.mem.read(pc);
  const hi = cpu.mem.read(pc + 1);
  cpu.regs.PC = (pc + 2) & 0xffff;
  const nn = (hi << 8) | lo;
  cpu.regs.WZ = nn;
  return nn;
}

// JP nn (and the unconditional fallthrough of JP cc / CALL nn).
// Reads target into WZ and sets PC.
function jpNN(cpu: Z80): void {
  cpu.regs.PC = fetchNN(cpu);
}

// CALL nn — push the return address (which is PC + 2 since fetchNN
// will advance PC past the operand) and jump.
function callNN(cpu: Z80): void {
  const nn = fetchNN(cpu);
  push16(cpu, cpu.regs.PC);
  cpu.regs.PC = nn;
}

// RET — pop PC, set WZ to the popped value.
function ret(cpu: Z80): void {
  const target = pop16(cpu);
  cpu.regs.WZ = target;
  cpu.regs.PC = target;
}

function rst(cpu: Z80, vector: number): void {
  push16(cpu, cpu.regs.PC);
  cpu.regs.WZ = vector;
  cpu.regs.PC = vector;
}

// CP / RET / JP / CALL conditions, indexed by the cc field of opcodes
// 0xC0..0xFF (cc = (op >> 3) & 7).
//   0 NZ   1 Z    2 NC   3 C    4 PO   5 PE   6 P    7 M
function condition(cpu: Z80, cc: number): boolean {
  const f = cpu.regs.F;
  switch (cc) {
    case 0:
      return (f & FLAG_Z) === 0;
    case 1:
      return (f & FLAG_Z) !== 0;
    case 2:
      return (f & FLAG_C) === 0;
    case 3:
      return (f & FLAG_C) !== 0;
    case 4:
      return (f & FLAG_PV) === 0;
    case 5:
      return (f & FLAG_PV) !== 0;
    case 6:
      return (f & FLAG_S) === 0;
    default:
      return (f & FLAG_S) !== 0;
  }
}

// Read+modify+write helper for INC/DEC (HL) / LD (HL),n etc. The
// caller supplies the modifier as an inline expression.
function rmw(cpu: Z80, addr: number, fn: (v: number) => number): void {
  const v = cpu.mem.read(addr);
  cpu.mem.write(addr, fn(v));
}

// The dispatcher itself. Each case ends with `return` so V8 can compile
// the switch to a jump table and skip the post-switch tail.
//
// runOneOp has already done the M1 fetch (regs.OP, PC++, incR, +4
// t-states); only the per-opcode work remains. The cycle counts added
// here are the *additional* t-states beyond that base 4 — INC/DEC of
// an 8-bit register costs 0 extra (the 4-state M1 is the whole op);
// LD r,n costs 3 (one MR); DJNZ ranges 1 / 5 depending on taken.
export function dispatchBase(cpu: Z80): void {
  const regs = cpu.regs;
  const mem = cpu.mem;
  const op = regs.OP;

  // prettier-ignore — the dense one-line case layout is intentional and
  // makes the opcode table readable as a table; preserving it requires
  // opting out of prettier's formatting for this single statement.
  // prettier-ignore
  switch (op) {
    case 0x00: // NOP
      return;
    case 0x01: // LD BC,nn
      regs.C = mem.read(regs.PC);
      regs.B = mem.read((regs.PC + 1) & 0xffff);
      regs.PC = (regs.PC + 2) & 0xffff;
      cpu.cycles += 6;
      return;
    case 0x02: // LD (BC),A
      mem.write(regs.BC, regs.A);
      regs.Z = (regs.C + 1) & 0xff;
      regs.W = regs.A;
      cpu.cycles += 3;
      return;
    case 0x03: // INC BC
      regs.BC = (regs.BC + 1) & 0xffff;
      cpu.cycles += 2;
      return;
    case 0x04: // INC B
      regs.B = inc8(cpu, regs.B);
      return;
    case 0x05: // DEC B
      regs.B = dec8(cpu, regs.B);
      return;
    case 0x06: // LD B,n
      regs.B = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      return;
    case 0x07: // RLCA
      rlca(cpu);
      return;
    case 0x08: // EX AF,AF'
      ex_af(cpu);
      return;
    case 0x09: // ADD HL,BC
      do_add16(cpu, "HL", regs.BC);
      cpu.cycles += 7;
      return;
    case 0x0a: // LD A,(BC)
      regs.A = mem.read(regs.BC);
      regs.WZ = (regs.BC + 1) & 0xffff;
      cpu.cycles += 3;
      return;
    case 0x0b: // DEC BC
      regs.BC = (regs.BC - 1) & 0xffff;
      cpu.cycles += 2;
      return;
    case 0x0c: // INC C
      regs.C = inc8(cpu, regs.C);
      return;
    case 0x0d: // DEC C
      regs.C = dec8(cpu, regs.C);
      return;
    case 0x0e: // LD C,n
      regs.C = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      return;
    case 0x0f: // RRCA
      rrca(cpu);
      return;

    case 0x10: { // DJNZ d
      const b = (regs.B - 1) & 0xff;
      regs.B = b;
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 4;
      if (b !== 0) {
        jrTaken(cpu, d);
        cpu.cycles += 5;
      } else {
        cpu.cycles += 1;
      }
      return;
    }
    case 0x11: // LD DE,nn
      regs.E = mem.read(regs.PC);
      regs.D = mem.read((regs.PC + 1) & 0xffff);
      regs.PC = (regs.PC + 2) & 0xffff;
      cpu.cycles += 6;
      return;
    case 0x12: // LD (DE),A
      mem.write(regs.DE, regs.A);
      regs.Z = (regs.E + 1) & 0xff;
      regs.W = regs.A;
      cpu.cycles += 3;
      return;
    case 0x13: regs.DE = (regs.DE + 1) & 0xffff; cpu.cycles += 2; return; // INC DE
    case 0x14: regs.D = inc8(cpu, regs.D); return;
    case 0x15: regs.D = dec8(cpu, regs.D); return;
    case 0x16: regs.D = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return; // LD D,n
    case 0x17: rla(cpu); return;
    case 0x18: { // JR d
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      jrTaken(cpu, d);
      cpu.cycles += 8;
      return;
    }
    case 0x19: do_add16(cpu, "HL", regs.DE); cpu.cycles += 7; return;
    case 0x1a: regs.A = mem.read(regs.DE); regs.WZ = (regs.DE + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x1b: regs.DE = (regs.DE - 1) & 0xffff; cpu.cycles += 2; return;
    case 0x1c: regs.E = inc8(cpu, regs.E); return;
    case 0x1d: regs.E = dec8(cpu, regs.E); return;
    case 0x1e: regs.E = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x1f: rra(cpu); return;

    case 0x20: { // JR NZ,d
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      if ((regs.F & FLAG_Z) === 0) {
        jrTaken(cpu, d);
        cpu.cycles += 5;
      }
      return;
    }
    case 0x21: regs.L = mem.read(regs.PC); regs.H = mem.read((regs.PC + 1) & 0xffff); regs.PC = (regs.PC + 2) & 0xffff; cpu.cycles += 6; return;
    case 0x22: { // LD (nn),HL
      const nn = fetchNN(cpu);
      mem.write(nn, regs.L);
      const wz = (nn + 1) & 0xffff;
      regs.WZ = wz;
      mem.write(wz, regs.H);
      cpu.cycles += 12;
      return;
    }
    case 0x23: regs.HL = (regs.HL + 1) & 0xffff; cpu.cycles += 2; return;
    case 0x24: regs.H = inc8(cpu, regs.H); return;
    case 0x25: regs.H = dec8(cpu, regs.H); return;
    case 0x26: regs.H = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x27: daa(cpu); return;
    case 0x28: { // JR Z,d
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      if ((regs.F & FLAG_Z) !== 0) {
        jrTaken(cpu, d);
        cpu.cycles += 5;
      }
      return;
    }
    case 0x29: do_add16(cpu, "HL", regs.HL); cpu.cycles += 7; return;
    case 0x2a: { // LD HL,(nn)
      const nn = fetchNN(cpu);
      regs.L = mem.read(nn);
      const wz = (nn + 1) & 0xffff;
      regs.WZ = wz;
      regs.H = mem.read(wz);
      cpu.cycles += 12;
      return;
    }
    case 0x2b: regs.HL = (regs.HL - 1) & 0xffff; cpu.cycles += 2; return;
    case 0x2c: regs.L = inc8(cpu, regs.L); return;
    case 0x2d: regs.L = dec8(cpu, regs.L); return;
    case 0x2e: regs.L = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x2f: cpl(cpu); return;

    case 0x30: { // JR NC,d
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      if ((regs.F & FLAG_C) === 0) {
        jrTaken(cpu, d);
        cpu.cycles += 5;
      }
      return;
    }
    case 0x31: regs.SPL = mem.read(regs.PC); regs.SPH = mem.read((regs.PC + 1) & 0xffff); regs.PC = (regs.PC + 2) & 0xffff; cpu.cycles += 6; return;
    case 0x32: { // LD (nn),A
      const nn = fetchNN(cpu);
      regs.Z = (nn + 1) & 0xff;
      regs.W = regs.A;
      mem.write(nn, regs.A);
      cpu.cycles += 9;
      return;
    }
    case 0x33: regs.SP = (regs.SP + 1) & 0xffff; cpu.cycles += 2; return;
    case 0x34: rmw(cpu, regs.HL, (v) => inc8(cpu, v)); cpu.cycles += 7; return;
    case 0x35: rmw(cpu, regs.HL, (v) => dec8(cpu, v)); cpu.cycles += 7; return;
    case 0x36: { // LD (HL),n
      const n = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      mem.write(regs.HL, n);
      cpu.cycles += 6;
      return;
    }
    case 0x37: scf(cpu); return;
    case 0x38: { // JR C,d
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      if ((regs.F & FLAG_C) !== 0) {
        jrTaken(cpu, d);
        cpu.cycles += 5;
      }
      return;
    }
    case 0x39: do_add16(cpu, "HL", regs.SP); cpu.cycles += 7; return;
    case 0x3a: { // LD A,(nn)
      const nn = fetchNN(cpu);
      regs.WZ = (nn + 1) & 0xffff;
      regs.A = mem.read(nn);
      cpu.cycles += 9;
      return;
    }
    case 0x3b: regs.SP = (regs.SP - 1) & 0xffff; cpu.cycles += 2; return;
    case 0x3c: regs.A = inc8(cpu, regs.A); return;
    case 0x3d: regs.A = dec8(cpu, regs.A); return;
    case 0x3e: regs.A = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x3f: ccf(cpu); return;

    // 0x40-0x7f: LD r,r' family. Self-LDs (LD B,B etc.) are 0-cost
    // beyond the M1 fetch; (HL) source/dest costs 3 extra t-states.
    case 0x40: return; // LD B,B
    case 0x41: regs.B = regs.C; return;
    case 0x42: regs.B = regs.D; return;
    case 0x43: regs.B = regs.E; return;
    case 0x44: regs.B = regs.H; return;
    case 0x45: regs.B = regs.L; return;
    case 0x46: regs.B = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x47: regs.B = regs.A; return;
    case 0x48: regs.C = regs.B; return;
    case 0x49: return; // LD C,C
    case 0x4a: regs.C = regs.D; return;
    case 0x4b: regs.C = regs.E; return;
    case 0x4c: regs.C = regs.H; return;
    case 0x4d: regs.C = regs.L; return;
    case 0x4e: regs.C = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x4f: regs.C = regs.A; return;
    case 0x50: regs.D = regs.B; return;
    case 0x51: regs.D = regs.C; return;
    case 0x52: return;
    case 0x53: regs.D = regs.E; return;
    case 0x54: regs.D = regs.H; return;
    case 0x55: regs.D = regs.L; return;
    case 0x56: regs.D = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x57: regs.D = regs.A; return;
    case 0x58: regs.E = regs.B; return;
    case 0x59: regs.E = regs.C; return;
    case 0x5a: regs.E = regs.D; return;
    case 0x5b: return;
    case 0x5c: regs.E = regs.H; return;
    case 0x5d: regs.E = regs.L; return;
    case 0x5e: regs.E = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x5f: regs.E = regs.A; return;
    case 0x60: regs.H = regs.B; return;
    case 0x61: regs.H = regs.C; return;
    case 0x62: regs.H = regs.D; return;
    case 0x63: regs.H = regs.E; return;
    case 0x64: return;
    case 0x65: regs.H = regs.L; return;
    case 0x66: regs.H = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x67: regs.H = regs.A; return;
    case 0x68: regs.L = regs.B; return;
    case 0x69: regs.L = regs.C; return;
    case 0x6a: regs.L = regs.D; return;
    case 0x6b: regs.L = regs.E; return;
    case 0x6c: regs.L = regs.H; return;
    case 0x6d: return;
    case 0x6e: regs.L = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x6f: regs.L = regs.A; return;
    case 0x70: mem.write(regs.HL, regs.B); cpu.cycles += 3; return;
    case 0x71: mem.write(regs.HL, regs.C); cpu.cycles += 3; return;
    case 0x72: mem.write(regs.HL, regs.D); cpu.cycles += 3; return;
    case 0x73: mem.write(regs.HL, regs.E); cpu.cycles += 3; return;
    case 0x74: mem.write(regs.HL, regs.H); cpu.cycles += 3; return;
    case 0x75: mem.write(regs.HL, regs.L); cpu.cycles += 3; return;
    case 0x76: cpu.halted = true; return; // HALT
    case 0x77: mem.write(regs.HL, regs.A); cpu.cycles += 3; return;
    case 0x78: regs.A = regs.B; return;
    case 0x79: regs.A = regs.C; return;
    case 0x7a: regs.A = regs.D; return;
    case 0x7b: regs.A = regs.E; return;
    case 0x7c: regs.A = regs.H; return;
    case 0x7d: regs.A = regs.L; return;
    case 0x7e: regs.A = mem.read(regs.HL); cpu.cycles += 3; return;
    case 0x7f: return;

    // 0x80-0xbf: 8-bit ALU with A. Each block of 8 follows the
    // src-register pattern B/C/D/E/H/L/(HL)/A.
    case 0x80: do_add_a(cpu, regs.B, false); return;
    case 0x81: do_add_a(cpu, regs.C, false); return;
    case 0x82: do_add_a(cpu, regs.D, false); return;
    case 0x83: do_add_a(cpu, regs.E, false); return;
    case 0x84: do_add_a(cpu, regs.H, false); return;
    case 0x85: do_add_a(cpu, regs.L, false); return;
    case 0x86: do_add_a(cpu, mem.read(regs.HL), false); cpu.cycles += 3; return;
    case 0x87: do_add_a(cpu, regs.A, false); return;
    case 0x88: do_add_a(cpu, regs.B, true); return;
    case 0x89: do_add_a(cpu, regs.C, true); return;
    case 0x8a: do_add_a(cpu, regs.D, true); return;
    case 0x8b: do_add_a(cpu, regs.E, true); return;
    case 0x8c: do_add_a(cpu, regs.H, true); return;
    case 0x8d: do_add_a(cpu, regs.L, true); return;
    case 0x8e: do_add_a(cpu, mem.read(regs.HL), true); cpu.cycles += 3; return;
    case 0x8f: do_add_a(cpu, regs.A, true); return;
    case 0x90: do_sub_a(cpu, regs.B, false); return;
    case 0x91: do_sub_a(cpu, regs.C, false); return;
    case 0x92: do_sub_a(cpu, regs.D, false); return;
    case 0x93: do_sub_a(cpu, regs.E, false); return;
    case 0x94: do_sub_a(cpu, regs.H, false); return;
    case 0x95: do_sub_a(cpu, regs.L, false); return;
    case 0x96: do_sub_a(cpu, mem.read(regs.HL), false); cpu.cycles += 3; return;
    case 0x97: do_sub_a(cpu, regs.A, false); return;
    case 0x98: do_sub_a(cpu, regs.B, true); return;
    case 0x99: do_sub_a(cpu, regs.C, true); return;
    case 0x9a: do_sub_a(cpu, regs.D, true); return;
    case 0x9b: do_sub_a(cpu, regs.E, true); return;
    case 0x9c: do_sub_a(cpu, regs.H, true); return;
    case 0x9d: do_sub_a(cpu, regs.L, true); return;
    case 0x9e: do_sub_a(cpu, mem.read(regs.HL), true); cpu.cycles += 3; return;
    case 0x9f: do_sub_a(cpu, regs.A, true); return;
    case 0xa0: and_a(cpu, regs.B); return;
    case 0xa1: and_a(cpu, regs.C); return;
    case 0xa2: and_a(cpu, regs.D); return;
    case 0xa3: and_a(cpu, regs.E); return;
    case 0xa4: and_a(cpu, regs.H); return;
    case 0xa5: and_a(cpu, regs.L); return;
    case 0xa6: and_a(cpu, mem.read(regs.HL)); cpu.cycles += 3; return;
    case 0xa7: and_a(cpu, regs.A); return;
    case 0xa8: xor_a(cpu, regs.B); return;
    case 0xa9: xor_a(cpu, regs.C); return;
    case 0xaa: xor_a(cpu, regs.D); return;
    case 0xab: xor_a(cpu, regs.E); return;
    case 0xac: xor_a(cpu, regs.H); return;
    case 0xad: xor_a(cpu, regs.L); return;
    case 0xae: xor_a(cpu, mem.read(regs.HL)); cpu.cycles += 3; return;
    case 0xaf: xor_a(cpu, regs.A); return;
    case 0xb0: or_a(cpu, regs.B); return;
    case 0xb1: or_a(cpu, regs.C); return;
    case 0xb2: or_a(cpu, regs.D); return;
    case 0xb3: or_a(cpu, regs.E); return;
    case 0xb4: or_a(cpu, regs.H); return;
    case 0xb5: or_a(cpu, regs.L); return;
    case 0xb6: or_a(cpu, mem.read(regs.HL)); cpu.cycles += 3; return;
    case 0xb7: or_a(cpu, regs.A); return;
    case 0xb8: do_cp_a(cpu, regs.B); return;
    case 0xb9: do_cp_a(cpu, regs.C); return;
    case 0xba: do_cp_a(cpu, regs.D); return;
    case 0xbb: do_cp_a(cpu, regs.E); return;
    case 0xbc: do_cp_a(cpu, regs.H); return;
    case 0xbd: do_cp_a(cpu, regs.L); return;
    case 0xbe: do_cp_a(cpu, mem.read(regs.HL)); cpu.cycles += 3; return;
    case 0xbf: do_cp_a(cpu, regs.A); return;

    // 0xc0-0xff: control + immediate-arithmetic + RST.
    case 0xc0: // RET NZ
      cpu.cycles += 1;
      if ((regs.F & FLAG_Z) === 0) {
        ret(cpu);
        cpu.cycles += 6;
      }
      return;
    case 0xc1: regs.BC = pop16(cpu); cpu.cycles += 6; return; // POP BC
    case 0xc2: { // JP NZ,nn
      const nn = fetchNN(cpu);
      cpu.cycles += 6;
      if ((regs.F & FLAG_Z) === 0) regs.PC = nn;
      return;
    }
    case 0xc3: jpNN(cpu); cpu.cycles += 6; return; // JP nn
    case 0xc4: { // CALL NZ,nn
      if ((regs.F & FLAG_Z) === 0) {
        callNN(cpu);
        cpu.cycles += 13;
      } else {
        fetchNN(cpu);
        cpu.cycles += 6;
      }
      return;
    }
    case 0xc5: push16(cpu, regs.BC); cpu.cycles += 7; return; // PUSH BC
    case 0xc6: // ADD A,n
      do_add_a(cpu, mem.read(regs.PC), false);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      return;
    case 0xc7: rst(cpu, 0x00); cpu.cycles += 7; return;
    case 0xc8: // RET Z
      cpu.cycles += 1;
      if ((regs.F & FLAG_Z) !== 0) {
        ret(cpu);
        cpu.cycles += 6;
      }
      return;
    case 0xc9: ret(cpu); cpu.cycles += 6; return;
    case 0xca: { // JP Z,nn
      const nn = fetchNN(cpu);
      cpu.cycles += 6;
      if ((regs.F & FLAG_Z) !== 0) regs.PC = nn;
      return;
    }
    case 0xcb: prefix_cb(cpu); return;
    case 0xcc: { // CALL Z,nn
      if ((regs.F & FLAG_Z) !== 0) {
        callNN(cpu);
        cpu.cycles += 13;
      } else {
        fetchNN(cpu);
        cpu.cycles += 6;
      }
      return;
    }
    case 0xcd: callNN(cpu); cpu.cycles += 13; return;
    case 0xce: // ADC A,n
      do_add_a(cpu, mem.read(regs.PC), true);
      regs.PC = (regs.PC + 1) & 0xffff;
      cpu.cycles += 3;
      return;
    case 0xcf: rst(cpu, 0x08); cpu.cycles += 7; return;

    case 0xd0: cpu.cycles += 1; if ((regs.F & FLAG_C) === 0) { ret(cpu); cpu.cycles += 6; } return;
    case 0xd1: regs.DE = pop16(cpu); cpu.cycles += 6; return;
    case 0xd2: { const nn = fetchNN(cpu); cpu.cycles += 6; if ((regs.F & FLAG_C) === 0) regs.PC = nn; return; }
    case 0xd3: { // OUT (n),A
      const port = ((regs.A << 8) | mem.read(regs.PC)) & 0xffff;
      regs.PC = (regs.PC + 1) & 0xffff;
      regs.W = regs.A;
      regs.Z = (port + 1) & 0xff;
      cpu.io.write(port, regs.A);
      cpu.cycles += 7;
      return;
    }
    case 0xd4: { if ((regs.F & FLAG_C) === 0) { callNN(cpu); cpu.cycles += 13; } else { fetchNN(cpu); cpu.cycles += 6; } return; }
    case 0xd5: push16(cpu, regs.DE); cpu.cycles += 7; return;
    case 0xd6: do_sub_a(cpu, mem.read(regs.PC), false); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0xd7: rst(cpu, 0x10); cpu.cycles += 7; return;
    case 0xd8: cpu.cycles += 1; if ((regs.F & FLAG_C) !== 0) { ret(cpu); cpu.cycles += 6; } return;
    case 0xd9: exx(cpu); return;
    case 0xda: { const nn = fetchNN(cpu); cpu.cycles += 6; if ((regs.F & FLAG_C) !== 0) regs.PC = nn; return; }
    case 0xdb: { // IN A,(n)
      const port = ((regs.A << 8) | mem.read(regs.PC)) & 0xffff;
      regs.PC = (regs.PC + 1) & 0xffff;
      regs.WZ = (port + 1) & 0xffff;
      regs.A = cpu.io.read(port);
      cpu.cycles += 7;
      return;
    }
    case 0xdc: { if ((regs.F & FLAG_C) !== 0) { callNN(cpu); cpu.cycles += 13; } else { fetchNN(cpu); cpu.cycles += 6; } return; }
    case 0xdd: prefix_dd(cpu); return;
    case 0xde: do_sub_a(cpu, mem.read(regs.PC), true); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0xdf: rst(cpu, 0x18); cpu.cycles += 7; return;

    case 0xe0: cpu.cycles += 1; if ((regs.F & FLAG_PV) === 0) { ret(cpu); cpu.cycles += 6; } return;
    case 0xe1: regs.HL = pop16(cpu); cpu.cycles += 6; return;
    case 0xe2: { const nn = fetchNN(cpu); cpu.cycles += 6; if ((regs.F & FLAG_PV) === 0) regs.PC = nn; return; }
    case 0xe3: { // EX (SP),HL
      const sp = regs.SP;
      const lo = mem.read(sp);
      const hi = mem.read((sp + 1) & 0xffff);
      mem.write((sp + 1) & 0xffff, regs.H);
      mem.write(sp, regs.L);
      regs.L = lo;
      regs.H = hi;
      regs.WZ = (hi << 8) | lo;
      cpu.cycles += 15;
      return;
    }
    case 0xe4: { if ((regs.F & FLAG_PV) === 0) { callNN(cpu); cpu.cycles += 13; } else { fetchNN(cpu); cpu.cycles += 6; } return; }
    case 0xe5: push16(cpu, regs.HL); cpu.cycles += 7; return;
    case 0xe6: and_a(cpu, mem.read(regs.PC)); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0xe7: rst(cpu, 0x20); cpu.cycles += 7; return;
    case 0xe8: cpu.cycles += 1; if ((regs.F & FLAG_PV) !== 0) { ret(cpu); cpu.cycles += 6; } return;
    case 0xe9: regs.PC = regs.HL; return; // JP (HL)
    case 0xea: { const nn = fetchNN(cpu); cpu.cycles += 6; if ((regs.F & FLAG_PV) !== 0) regs.PC = nn; return; }
    case 0xeb: ex_de_hl(cpu); return;
    case 0xec: { if ((regs.F & FLAG_PV) !== 0) { callNN(cpu); cpu.cycles += 13; } else { fetchNN(cpu); cpu.cycles += 6; } return; }
    case 0xed: prefix_ed(cpu); return;
    case 0xee: xor_a(cpu, mem.read(regs.PC)); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0xef: rst(cpu, 0x28); cpu.cycles += 7; return;

    case 0xf0: cpu.cycles += 1; if ((regs.F & FLAG_S) === 0) { ret(cpu); cpu.cycles += 6; } return;
    case 0xf1: regs.AF = pop16(cpu); cpu.cycles += 6; return;
    case 0xf2: { const nn = fetchNN(cpu); cpu.cycles += 6; if ((regs.F & FLAG_S) === 0) regs.PC = nn; return; }
    case 0xf3: di(cpu); return;
    case 0xf4: { if ((regs.F & FLAG_S) === 0) { callNN(cpu); cpu.cycles += 13; } else { fetchNN(cpu); cpu.cycles += 6; } return; }
    case 0xf5: push16(cpu, regs.AF); cpu.cycles += 7; return;
    case 0xf6: or_a(cpu, mem.read(regs.PC)); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0xf7: rst(cpu, 0x30); cpu.cycles += 7; return;
    case 0xf8: cpu.cycles += 1; if ((regs.F & FLAG_S) !== 0) { ret(cpu); cpu.cycles += 6; } return;
    case 0xf9: regs.SP = regs.HL; cpu.cycles += 2; return; // LD SP,HL
    case 0xfa: { const nn = fetchNN(cpu); cpu.cycles += 6; if ((regs.F & FLAG_S) !== 0) regs.PC = nn; return; }
    case 0xfb: ei(cpu); return;
    case 0xfc: { if ((regs.F & FLAG_S) !== 0) { callNN(cpu); cpu.cycles += 13; } else { fetchNN(cpu); cpu.cycles += 6; } return; }
    case 0xfd: prefix_fd(cpu); return;
    case 0xfe: do_cp_a(cpu, mem.read(regs.PC)); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0xff: rst(cpu, 0x38); cpu.cycles += 7; return;
  }

  // Unreachable — every byte 0x00..0xff is covered above.
  // The `condition` helper is declared so its identifier escapes the
  // dead-code elimination check; it's kept available for whoever
  // extends this dispatcher to ED/CB/etc.
  void condition;
}

// ---------------------------------------------------------------------------
// ED-prefix dispatcher.
//
// Most ED bytes have no effect (real Z80 treats unmapped ED-XX as a 2-byte
// NOP that consumes 8 t-states). The implemented set covers IN/OUT,
// SBC/ADC HL,rr, LD (nn),rr / LD rr,(nn), LD I/R/A inter-transfers, NEG,
// RETN/RETI, IM modes, RRD/RLD, and the block ops (LDI/LDD/LDIR/LDDR,
// CPI/CPD/CPIR/CPDR, INI/IND/INIR/INDR, OUTI/OUTD/OTIR/OTDR).
//
// runOneOp has already done the M1 fetch for the ED byte AND the M1
// fetch for the operation byte (the prefix dispatch fetched ED → set
// prefix=ED → next runOneOp fetched the op byte). Both R increments
// and both 4-state charges happened. dispatchED only needs to add the
// per-op extras.

function inRegFromC(cpu: Z80): u8 {
  const port = cpu.regs.BC;
  const value = cpu.io.read(port);
  cpu.regs.WZ = (port + 1) & 0xffff;
  cpu.updateFlags({
    n: 0,
    pv: parity(value),
    h: 0,
    z: value === 0,
    s: value & 0x80,
    x: value & FLAG_X,
    y: value & FLAG_Y,
  });
  return value;
}

function outRegFromC(cpu: Z80, value: u8): void {
  const port = cpu.regs.BC;
  cpu.io.write(port, value);
  cpu.regs.WZ = (port + 1) & 0xffff;
}

// LD (nn),rr — write rr lo/hi to nn / nn+1. WZ ends up at nn+1.
function ldNNrr(cpu: Z80, hi: number, lo: number): void {
  const nn = fetchNN(cpu);
  cpu.mem.write(nn, lo);
  const wz = (nn + 1) & 0xffff;
  cpu.regs.WZ = wz;
  cpu.mem.write(wz, hi);
  cpu.cycles += 12;
}

// LD rr,(nn) — read into rr lo/hi from nn / nn+1. WZ at nn+1.
function ldRRnn(cpu: Z80): { lo: u8; hi: u8 } {
  const nn = fetchNN(cpu);
  const lo = cpu.mem.read(nn);
  const wz = (nn + 1) & 0xffff;
  cpu.regs.WZ = wz;
  const hi = cpu.mem.read(wz);
  cpu.cycles += 12;
  return { lo, hi };
}

// RETN / RETI both pop PC and on real silicon also restore IFF1 from IFF2.
function retn(cpu: Z80): void {
  cpu.iff1 = cpu.iff2;
  const target = pop16(cpu);
  cpu.regs.WZ = target;
  cpu.regs.PC = target;
  cpu.cycles += 10;
}

// LDI/LDD/LDIR/LDDR shared body. delta = +1 for forward, -1 for backward;
// repeat = true loops while BC != 0.
function ldBlock(cpu: Z80, delta: 1 | -1, repeat: boolean): void {
  const regs = cpu.regs;
  const v = cpu.mem.read(regs.HL);
  cpu.mem.write(regs.DE, v);
  regs.HL = (regs.HL + delta) & 0xffff;
  regs.DE = (regs.DE + delta) & 0xffff;
  regs.BC = (regs.BC - 1) & 0xffff;
  const repeating = repeat && regs.BC !== 0;
  if (repeating) {
    regs.PC = (regs.PC - 2) & 0xffff;
    regs.WZ = (regs.PC + 1) & 0xffff;
  }
  do_ld_block(cpu, v, repeating);
  cpu.cycles += repeating ? 13 : 8;
}

function cpBlock(cpu: Z80, delta: 1 | -1, repeat: boolean): void {
  const regs = cpu.regs;
  const v = cpu.mem.read(regs.HL);
  regs.BC = (regs.BC - 1) & 0xffff;
  const result = (regs.A - v) & 0xff;
  regs.HL = (regs.HL + delta) & 0xffff;
  regs.WZ = (regs.WZ + delta) & 0xffff;
  const repeating = repeat && regs.BC !== 0 && result !== 0;
  if (repeating) {
    regs.PC = (regs.PC - 2) & 0xffff;
    regs.WZ = (regs.PC + 1) & 0xffff;
  }
  do_cp_block(cpu, v, repeating);
  cpu.cycles += repeating ? 13 : 8;
}

function inBlock(cpu: Z80, delta: 1 | -1, repeat: boolean): void {
  const regs = cpu.regs;
  const port = regs.BC;
  const v = cpu.io.read(port);
  regs.WZ = (port + delta) & 0xffff;
  cpu.mem.write(regs.HL, v);
  regs.HL = (regs.HL + delta) & 0xffff;
  regs.B = (regs.B - 1) & 0xff;
  const base = ((regs.C + delta) & 0xff) + v;
  const repeating = repeat && regs.B !== 0;
  if (repeating) {
    regs.PC = (regs.PC - 2) & 0xffff;
    regs.WZ = (regs.PC + 1) & 0xffff;
  }
  do_io_block_flags(cpu, v, base, repeating);
  cpu.cycles += repeating ? 13 : 8;
}

function outBlock(cpu: Z80, delta: 1 | -1, repeat: boolean): void {
  const regs = cpu.regs;
  const v = cpu.mem.read(regs.HL);
  regs.B = (regs.B - 1) & 0xff;
  const port = regs.BC;
  cpu.io.write(port, v);
  regs.HL = (regs.HL + delta) & 0xffff;
  regs.WZ = (port + delta) & 0xffff;
  const base = (regs.L + v) & 0x1ff;
  const repeating = repeat && regs.B !== 0;
  if (repeating) {
    regs.PC = (regs.PC - 2) & 0xffff;
    regs.WZ = (regs.PC + 1) & 0xffff;
  }
  do_io_block_flags(cpu, v, base, repeating);
  cpu.cycles += repeating ? 13 : 8;
}

export function dispatchED(cpu: Z80): void {
  const regs = cpu.regs;
  const op = regs.OP;

  // prettier-ignore — the dense one-line case layout is intentional and
  // makes the opcode table readable as a table; preserving it requires
  // opting out of prettier's formatting for this single statement.
  // prettier-ignore
  switch (op) {
    // ---------------- 0x40-0x4F ----------------
    case 0x40: regs.B = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x41: outRegFromC(cpu, regs.B); cpu.cycles += 4; return;
    case 0x42: do_sbc_hl(cpu, regs.BC); cpu.cycles += 7; return;
    case 0x43: ldNNrr(cpu, regs.B, regs.C); return;
    case 0x44: do_neg(cpu); return;
    case 0x45: retn(cpu); return;
    case 0x46: cpu.im = 0; return;
    case 0x47: regs.I = regs.A; cpu.cycles += 1; return; // LD I,A
    case 0x48: regs.C = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x49: outRegFromC(cpu, regs.C); cpu.cycles += 4; return;
    case 0x4a: do_adc_hl(cpu, regs.BC); cpu.cycles += 7; return;
    case 0x4b: { const { lo, hi } = ldRRnn(cpu); regs.C = lo; regs.B = hi; return; }
    case 0x4c: do_neg(cpu); return; // NEG (alias)
    case 0x4d: retn(cpu); return; // RETI (same as RETN per silicon)
    case 0x4e: cpu.im = 0; return; // IM 0/1 alias
    case 0x4f: regs.R = regs.A; cpu.cycles += 1; return; // LD R,A

    // ---------------- 0x50-0x5F ----------------
    case 0x50: regs.D = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x51: outRegFromC(cpu, regs.D); cpu.cycles += 4; return;
    case 0x52: do_sbc_hl(cpu, regs.DE); cpu.cycles += 7; return;
    case 0x53: ldNNrr(cpu, regs.D, regs.E); return;
    case 0x54: do_neg(cpu); return;
    case 0x55: retn(cpu); return;
    case 0x56: cpu.im = 1; return;
    case 0x57: do_ld_a_ir(cpu, regs.I); cpu.cycles += 1; return; // LD A,I
    case 0x58: regs.E = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x59: outRegFromC(cpu, regs.E); cpu.cycles += 4; return;
    case 0x5a: do_adc_hl(cpu, regs.DE); cpu.cycles += 7; return;
    case 0x5b: { const { lo, hi } = ldRRnn(cpu); regs.E = lo; regs.D = hi; return; }
    case 0x5c: do_neg(cpu); return;
    case 0x5d: retn(cpu); return;
    case 0x5e: cpu.im = 2; return;
    case 0x5f: do_ld_a_ir(cpu, regs.R); cpu.cycles += 1; return; // LD A,R

    // ---------------- 0x60-0x6F ----------------
    case 0x60: regs.H = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x61: outRegFromC(cpu, regs.H); cpu.cycles += 4; return;
    case 0x62: do_sbc_hl(cpu, regs.HL); cpu.cycles += 7; return;
    case 0x63: ldNNrr(cpu, regs.H, regs.L); return;
    case 0x64: do_neg(cpu); return;
    case 0x65: retn(cpu); return;
    case 0x66: cpu.im = 0; return;
    case 0x67: { // RRD
      const v = cpu.mem.read(regs.HL);
      do_rrd(cpu, v);
      cpu.mem.write(regs.HL, regs.OPx);
      cpu.cycles += 14;
      return;
    }
    case 0x68: regs.L = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x69: outRegFromC(cpu, regs.L); cpu.cycles += 4; return;
    case 0x6a: do_adc_hl(cpu, regs.HL); cpu.cycles += 7; return;
    case 0x6b: { const { lo, hi } = ldRRnn(cpu); regs.L = lo; regs.H = hi; return; }
    case 0x6c: do_neg(cpu); return;
    case 0x6d: retn(cpu); return;
    case 0x6e: cpu.im = 0; return;
    case 0x6f: { // RLD
      const v = cpu.mem.read(regs.HL);
      do_rld(cpu, v);
      cpu.mem.write(regs.HL, regs.OPx);
      cpu.cycles += 14;
      return;
    }

    // ---------------- 0x70-0x7F ----------------
    case 0x70: { // IN F,(C) — read for flags only, no register write
      const port = regs.BC;
      const value = cpu.io.read(port);
      regs.WZ = (port + 1) & 0xffff;
      cpu.updateFlags({
        n: 0, pv: parity(value), h: 0,
        z: value === 0, s: value & 0x80,
        x: value & FLAG_X, y: value & FLAG_Y,
      });
      cpu.cycles += 4;
      return;
    }
    case 0x71: { // OUT (C),0
      const port = regs.BC;
      cpu.io.write(port, 0);
      regs.WZ = (port + 1) & 0xffff;
      cpu.cycles += 4;
      return;
    }
    case 0x72: do_sbc_hl(cpu, regs.SP); cpu.cycles += 7; return;
    case 0x73: ldNNrr(cpu, regs.SPH, regs.SPL); return; // LD (nn),SP
    case 0x74: do_neg(cpu); return;
    case 0x75: retn(cpu); return;
    case 0x76: cpu.im = 1; return;
    case 0x77: return; // documented NOP (ED 77)
    case 0x78: regs.A = inRegFromC(cpu); cpu.cycles += 4; return;
    case 0x79: outRegFromC(cpu, regs.A); cpu.cycles += 4; return;
    case 0x7a: do_adc_hl(cpu, regs.SP); cpu.cycles += 7; return;
    case 0x7b: { const { lo, hi } = ldRRnn(cpu); regs.SPL = lo; regs.SPH = hi; return; }
    case 0x7c: do_neg(cpu); return;
    case 0x7d: retn(cpu); return;
    case 0x7e: cpu.im = 2; return;
    case 0x7f: return; // documented NOP (ED 7F)

    // ---------------- 0xA0-0xA3, 0xA8-0xAB: non-repeating block ops ----------------
    case 0xa0: ldBlock(cpu, 1, false); return; // LDI
    case 0xa1: cpBlock(cpu, 1, false); return; // CPI
    case 0xa2: inBlock(cpu, 1, false); return; // INI
    case 0xa3: outBlock(cpu, 1, false); return; // OUTI
    case 0xa8: ldBlock(cpu, -1, false); return; // LDD
    case 0xa9: cpBlock(cpu, -1, false); return; // CPD
    case 0xaa: inBlock(cpu, -1, false); return; // IND
    case 0xab: outBlock(cpu, -1, false); return; // OUTD

    // ---------------- 0xB0-0xB3, 0xB8-0xBB: repeating block ops ----------------
    case 0xb0: ldBlock(cpu, 1, true); return; // LDIR
    case 0xb1: cpBlock(cpu, 1, true); return; // CPIR
    case 0xb2: inBlock(cpu, 1, true); return; // INIR
    case 0xb3: outBlock(cpu, 1, true); return; // OTIR
    case 0xb8: ldBlock(cpu, -1, true); return; // LDDR
    case 0xb9: cpBlock(cpu, -1, true); return; // CPDR
    case 0xba: inBlock(cpu, -1, true); return; // INDR
    case 0xbb: outBlock(cpu, -1, true); return; // OTDR

    default:
      // Every other ED byte is a documented 2-byte NOP. The M1 fetches
      // for both bytes have already happened (R bumped twice, 8 t-states
      // charged); nothing more to do.
      return;
  }
}

// ---------------------------------------------------------------------------
// CB-prefix dispatcher.
//
// Encoding: bbb_ttt where bbb is the operation group and ttt is the target.
//   00_ooo_ttt   rotate/shift (RLC/RRC/RL/RR/SLA/SRA/SLL/SRL)
//   01_bbb_ttt   BIT b,target
//   10_bbb_ttt   RES b,target
//   11_bbb_ttt   SET b,target
//
// Target slot 6 means (HL) — read+modify+write. Slots 0..5,7 are the
// registers B/C/D/E/H/L/-/A. Rather than 256 hand-written cases, the
// dispatcher reads the operand once into a single local, applies the
// appropriate operation, and writes back; the operation switch is on the
// top 5 bits and the target switch is on the bottom 3.
//
// Flag-setting on shift/rotate ops mirrors `setShiftFlags` from ops.ts.
// BIT's flag rule for BIT b,(HL) takes X/Y from W (the high half of WZ
// at the time of the read), per Sean Young.

function setShiftFlags(cpu: Z80, result: u8, carryOut: number): void {
  cpu.updateFlags({
    c: carryOut,
    n: 0,
    pv: parity(result),
    h: 0,
    z: result === 0,
    s: result & 0x80,
    x: result & FLAG_X,
    y: result & FLAG_Y,
  });
}

// Read the operand for a CB op given the target slot. Slot 6 = (HL); also
// charges 3 t-states for the memory read.
function cbReadOperand(cpu: Z80, slot: number): u8 {
  const regs = cpu.regs;
  // prettier-ignore
  switch (slot) {
    case 0: return regs.B;
    case 1: return regs.C;
    case 2: return regs.D;
    case 3: return regs.E;
    case 4: return regs.H;
    case 5: return regs.L;
    case 6: cpu.cycles += 3; return cpu.mem.read(regs.HL);
    default: return regs.A;
  }
}

function cbWriteOperand(cpu: Z80, slot: number, value: u8): void {
  const regs = cpu.regs;
  // prettier-ignore
  switch (slot) {
    case 0: regs.B = value; return;
    case 1: regs.C = value; return;
    case 2: regs.D = value; return;
    case 3: regs.E = value; return;
    case 4: regs.H = value; return;
    case 5: regs.L = value; return;
    case 6: cpu.mem.write(regs.HL, value); cpu.cycles += 4; return;
    case 7: regs.A = value; return;
  }
}

export function dispatchCB(cpu: Z80): void {
  const op = cpu.regs.OP;
  const slot = op & 7;
  const isMem = slot === 6;
  const v = cbReadOperand(cpu, slot);
  const subOp = (op >> 3) & 7;
  const group = op >> 6;

  if (group === 0) {
    // Rotate / shift.
    let result: u8;
    let c: number;
    // prettier-ignore
    switch (subOp) {
      case 0: // RLC
        c = (v >> 7) & 1;
        result = ((v << 1) | c) & 0xff;
        break;
      case 1: // RRC
        c = v & 1;
        result = ((v >> 1) | (c << 7)) & 0xff;
        break;
      case 2: { // RL — through carry
        const carryIn = cpu.regs.F & FLAG_C ? 1 : 0;
        c = (v >> 7) & 1;
        result = ((v << 1) | carryIn) & 0xff;
        break;
      }
      case 3: { // RR
        const carryIn = cpu.regs.F & FLAG_C ? 0x80 : 0;
        c = v & 1;
        result = ((v >> 1) | carryIn) & 0xff;
        break;
      }
      case 4: // SLA
        c = (v >> 7) & 1;
        result = (v << 1) & 0xff;
        break;
      case 5: // SRA
        c = v & 1;
        result = ((v >> 1) | (v & 0x80)) & 0xff;
        break;
      case 6: // SLL (undocumented)
        c = (v >> 7) & 1;
        result = ((v << 1) | 1) & 0xff;
        break;
      default: // SRL
        c = v & 1;
        result = (v >> 1) & 0xff;
        break;
    }
    setShiftFlags(cpu, result, c);
    cbWriteOperand(cpu, slot, result);
    return;
  }

  if (group === 1) {
    // BIT b,target — no write-back. X/Y for the (HL) variant come from
    // W (the high byte of WZ); for register variants, from the operand.
    const isSet = (v & (1 << subOp)) !== 0;
    const xySource = isMem ? cpu.regs.W : v;
    cpu.updateFlags({
      n: 0,
      pv: !isSet,
      h: 1,
      z: !isSet,
      s: subOp === 7 && isSet ? 1 : 0,
      x: xySource & FLAG_X,
      y: xySource & FLAG_Y,
    });
    return;
  }

  if (group === 2) {
    // RES b,target
    const result = v & ~(1 << subOp) & 0xff;
    cbWriteOperand(cpu, slot, result);
    return;
  }

  // group === 3: SET b,target
  const result = v | (1 << subOp);
  cbWriteOperand(cpu, slot, result);
}

// ---------------------------------------------------------------------------
// DD-prefix (IX) dispatcher.
//
// DD prefix replaces HL with IX, H with IXH, L with IXL, and (HL) with
// (IX+d) (a signed displacement byte fetched after the op byte).
// Sean Young's H/L disambiguation rule applies: when an opcode has both
// a register operand AND an (HL) memory operand (LD r,(HL), LD (HL),r,
// arithmetic with (HL)), the H/L register operand is *not* swapped to
// IXH/IXL — only the address mode is. The literal H/L paths fall
// through to dispatchBase.
//
// runOneOp has done the M1 fetch for both DD and the op byte. dispatchDD
// only adds the per-op extras.
//
// For ops that don't touch HL/H/L (NOP, EX AF, INC B, etc.) the DD
// prefix is wasted and dispatchDD falls through to dispatchBase.

// Fetch the signed displacement byte and return IX + d (mod 0x10000).
// Adds the 5-state "internal delay" the real CPU spends computing the
// effective address before the memory operation.
function ixDisp(cpu: Z80, base: number): number {
  const d = cpu.mem.read(cpu.regs.PC);
  cpu.regs.PC = (cpu.regs.PC + 1) & 0xffff;
  const addr = (base + asS8(d)) & 0xffff;
  cpu.regs.WZ = addr;
  cpu.cycles += 8; // 3 (disp fetch) + 5 (internal delay)
  return addr;
}

// LD (IX+d),n — disp-fetch order is unusual: opcode, disp, n, 2-state
// pause, write. (Most indexed ops have 5 internal states between disp
// and the memory access; LD (IX+d),n has 2 because the n-fetch overlaps
// the address calculation.)
function ixDispImm(cpu: Z80, base: number): { addr: number; n: u8 } {
  const d = cpu.mem.read(cpu.regs.PC);
  const n = cpu.mem.read((cpu.regs.PC + 1) & 0xffff);
  cpu.regs.PC = (cpu.regs.PC + 2) & 0xffff;
  const addr = (base + asS8(d)) & 0xffff;
  cpu.regs.WZ = addr;
  cpu.cycles += 8; // disp + n + 2
  return { addr, n };
}

export function dispatchDD(cpu: Z80): void {
  const regs = cpu.regs;
  const mem = cpu.mem;
  const op = regs.OP;

  // prettier-ignore — the dense one-line case layout is intentional and
  // makes the opcode table readable as a table; preserving it requires
  // opting out of prettier's formatting for this single statement.
  // prettier-ignore
  switch (op) {
    // ---------------- 16-bit / IX-pair ----------------
    case 0x09: do_add16(cpu, "IX", regs.BC); cpu.cycles += 7; return;
    case 0x19: do_add16(cpu, "IX", regs.DE); cpu.cycles += 7; return;
    case 0x29: do_add16(cpu, "IX", regs.IX); cpu.cycles += 7; return;
    case 0x39: do_add16(cpu, "IX", regs.SP); cpu.cycles += 7; return;
    case 0x21: // LD IX,nn
      regs.IXL = mem.read(regs.PC);
      regs.IXH = mem.read((regs.PC + 1) & 0xffff);
      regs.PC = (regs.PC + 2) & 0xffff;
      cpu.cycles += 6;
      return;
    case 0x22: { // LD (nn),IX
      const nn = fetchNN(cpu);
      mem.write(nn, regs.IXL);
      const wz = (nn + 1) & 0xffff;
      regs.WZ = wz;
      mem.write(wz, regs.IXH);
      cpu.cycles += 12;
      return;
    }
    case 0x2a: { // LD IX,(nn)
      const nn = fetchNN(cpu);
      regs.IXL = mem.read(nn);
      const wz = (nn + 1) & 0xffff;
      regs.WZ = wz;
      regs.IXH = mem.read(wz);
      cpu.cycles += 12;
      return;
    }
    case 0x23: regs.IX = (regs.IX + 1) & 0xffff; cpu.cycles += 2; return;
    case 0x2b: regs.IX = (regs.IX - 1) & 0xffff; cpu.cycles += 2; return;

    // ---------------- IXH / IXL ----------------
    case 0x24: regs.IXH = inc8(cpu, regs.IXH); return;
    case 0x25: regs.IXH = dec8(cpu, regs.IXH); return;
    case 0x26: regs.IXH = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x2c: regs.IXL = inc8(cpu, regs.IXL); return;
    case 0x2d: regs.IXL = dec8(cpu, regs.IXL); return;
    case 0x2e: regs.IXL = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;

    // ---------------- (IX+d) read/modify/write ----------------
    case 0x34: { // INC (IX+d)
      const addr = ixDisp(cpu, regs.IX);
      mem.write(addr, inc8(cpu, mem.read(addr)));
      cpu.cycles += 7;
      return;
    }
    case 0x35: { // DEC (IX+d)
      const addr = ixDisp(cpu, regs.IX);
      mem.write(addr, dec8(cpu, mem.read(addr)));
      cpu.cycles += 7;
      return;
    }
    case 0x36: { // LD (IX+d),n
      const { addr, n } = ixDispImm(cpu, regs.IX);
      mem.write(addr, n);
      cpu.cycles += 3;
      return;
    }

    // ---------------- LD r,IXH / LD r,IXL (no mem operand) ----------------
    case 0x44: regs.B = regs.IXH; return;
    case 0x45: regs.B = regs.IXL; return;
    case 0x4c: regs.C = regs.IXH; return;
    case 0x4d: regs.C = regs.IXL; return;
    case 0x54: regs.D = regs.IXH; return;
    case 0x55: regs.D = regs.IXL; return;
    case 0x5c: regs.E = regs.IXH; return;
    case 0x5d: regs.E = regs.IXL; return;
    case 0x7c: regs.A = regs.IXH; return;
    case 0x7d: regs.A = regs.IXL; return;

    // ---------------- LD IXH,r / LD IXL,r (0x60-0x67, 0x68-0x6f) ----------------
    // Sean Young: IXH/IXL as destination is unaffected when source is
    // (HL) (which becomes (IX+d) instead). 0x66 / 0x6e keep the H/L
    // destination literal — see below.
    case 0x60: regs.IXH = regs.B; return;
    case 0x61: regs.IXH = regs.C; return;
    case 0x62: regs.IXH = regs.D; return;
    case 0x63: regs.IXH = regs.E; return;
    case 0x64: return; // LD IXH,IXH
    case 0x65: regs.IXH = regs.IXL; return;
    case 0x67: regs.IXH = regs.A; return;
    case 0x68: regs.IXL = regs.B; return;
    case 0x69: regs.IXL = regs.C; return;
    case 0x6a: regs.IXL = regs.D; return;
    case 0x6b: regs.IXL = regs.E; return;
    case 0x6c: regs.IXL = regs.IXH; return;
    case 0x6d: return; // LD IXL,IXL
    case 0x6f: regs.IXL = regs.A; return;

    // ---------------- LD r,(IX+d) — H/L stay literal ----------------
    case 0x46: regs.B = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;
    case 0x4e: regs.C = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;
    case 0x56: regs.D = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;
    case 0x5e: regs.E = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;
    case 0x66: regs.H = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;
    case 0x6e: regs.L = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;
    case 0x7e: regs.A = mem.read(ixDisp(cpu, regs.IX)); cpu.cycles += 3; return;

    // ---------------- LD (IX+d),r — H/L stay literal ----------------
    case 0x70: mem.write(ixDisp(cpu, regs.IX), regs.B); cpu.cycles += 3; return;
    case 0x71: mem.write(ixDisp(cpu, regs.IX), regs.C); cpu.cycles += 3; return;
    case 0x72: mem.write(ixDisp(cpu, regs.IX), regs.D); cpu.cycles += 3; return;
    case 0x73: mem.write(ixDisp(cpu, regs.IX), regs.E); cpu.cycles += 3; return;
    case 0x74: mem.write(ixDisp(cpu, regs.IX), regs.H); cpu.cycles += 3; return;
    case 0x75: mem.write(ixDisp(cpu, regs.IX), regs.L); cpu.cycles += 3; return;
    case 0x77: mem.write(ixDisp(cpu, regs.IX), regs.A); cpu.cycles += 3; return;
    // 0x76 HALT is unaffected by DD — falls through to dispatchBase.

    // ---------------- 8-bit ALU with IXH / IXL / (IX+d) ----------------
    case 0x84: do_add_a(cpu, regs.IXH, false); return;
    case 0x85: do_add_a(cpu, regs.IXL, false); return;
    case 0x86: do_add_a(cpu, mem.read(ixDisp(cpu, regs.IX)), false); cpu.cycles += 3; return;
    case 0x8c: do_add_a(cpu, regs.IXH, true); return;
    case 0x8d: do_add_a(cpu, regs.IXL, true); return;
    case 0x8e: do_add_a(cpu, mem.read(ixDisp(cpu, regs.IX)), true); cpu.cycles += 3; return;
    case 0x94: do_sub_a(cpu, regs.IXH, false); return;
    case 0x95: do_sub_a(cpu, regs.IXL, false); return;
    case 0x96: do_sub_a(cpu, mem.read(ixDisp(cpu, regs.IX)), false); cpu.cycles += 3; return;
    case 0x9c: do_sub_a(cpu, regs.IXH, true); return;
    case 0x9d: do_sub_a(cpu, regs.IXL, true); return;
    case 0x9e: do_sub_a(cpu, mem.read(ixDisp(cpu, regs.IX)), true); cpu.cycles += 3; return;
    case 0xa4: and_a(cpu, regs.IXH); return;
    case 0xa5: and_a(cpu, regs.IXL); return;
    case 0xa6: and_a(cpu, mem.read(ixDisp(cpu, regs.IX))); cpu.cycles += 3; return;
    case 0xac: xor_a(cpu, regs.IXH); return;
    case 0xad: xor_a(cpu, regs.IXL); return;
    case 0xae: xor_a(cpu, mem.read(ixDisp(cpu, regs.IX))); cpu.cycles += 3; return;
    case 0xb4: or_a(cpu, regs.IXH); return;
    case 0xb5: or_a(cpu, regs.IXL); return;
    case 0xb6: or_a(cpu, mem.read(ixDisp(cpu, regs.IX))); cpu.cycles += 3; return;
    case 0xbc: do_cp_a(cpu, regs.IXH); return;
    case 0xbd: do_cp_a(cpu, regs.IXL); return;
    case 0xbe: do_cp_a(cpu, mem.read(ixDisp(cpu, regs.IX))); cpu.cycles += 3; return;

    // ---------------- IX-pair stack/jump ops ----------------
    case 0xe1: regs.IX = pop16(cpu); cpu.cycles += 6; return;
    case 0xe3: { // EX (SP),IX
      const sp = regs.SP;
      const lo = mem.read(sp);
      const hi = mem.read((sp + 1) & 0xffff);
      mem.write((sp + 1) & 0xffff, regs.IXH);
      mem.write(sp, regs.IXL);
      regs.IXL = lo;
      regs.IXH = hi;
      regs.WZ = (hi << 8) | lo;
      cpu.cycles += 15;
      return;
    }
    case 0xe5: push16(cpu, regs.IX); cpu.cycles += 7; return;
    case 0xe9: regs.PC = regs.IX; return; // JP (IX)
    case 0xf9: regs.SP = regs.IX; cpu.cycles += 2; return;

    // ---------------- prefix bytes ----------------
    // DD followed by another DD/FD/ED/CB — the inner prefix takes over.
    // For DDCB, the displacement and op byte are fetched here so the
    // CB-table dispatch sees a populated WZ.
    case 0xdd: prefix_dd(cpu); return;
    case 0xed: prefix_ed(cpu); return;
    case 0xfd: prefix_fd(cpu); return;
    case 0xcb: { // PREFIX CB, with the DDCB fetch sequence
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      const disp = asS8(d);
      regs.WZ = (regs.IX + disp) & 0xffff;
      cpu.prefix = { type: "DDCB", displacement: disp };
      cpu.cycles += 4; // disp fetch + 1 internal
      return;
    }

    default:
      // Anything not in the override list is unaffected by DD — run the
      // base-table semantics. NOP, EX AF, EI, ADD A,B, etc. all land here.
      dispatchBase(cpu);
      return;
  }
}

// ---------------------------------------------------------------------------
// FD-prefix (IY) dispatcher.
//
// Mechanically identical to dispatchDD with IX → IY / IXH → IYH / IXL → IYL.
// Kept as its own function so V8 sees a stable hidden class on each
// dispatch site; an alternative would be a single parameterised dispatcher
// with a RegSet, but the indirect property accesses cost more than the
// duplication in maintenance.

function iyDisp(cpu: Z80, base: number): number {
  const d = cpu.mem.read(cpu.regs.PC);
  cpu.regs.PC = (cpu.regs.PC + 1) & 0xffff;
  const addr = (base + asS8(d)) & 0xffff;
  cpu.regs.WZ = addr;
  cpu.cycles += 8;
  return addr;
}

function iyDispImm(cpu: Z80, base: number): { addr: number; n: u8 } {
  const d = cpu.mem.read(cpu.regs.PC);
  const n = cpu.mem.read((cpu.regs.PC + 1) & 0xffff);
  cpu.regs.PC = (cpu.regs.PC + 2) & 0xffff;
  const addr = (base + asS8(d)) & 0xffff;
  cpu.regs.WZ = addr;
  cpu.cycles += 8;
  return { addr, n };
}

export function dispatchFD(cpu: Z80): void {
  const regs = cpu.regs;
  const mem = cpu.mem;
  const op = regs.OP;

  // prettier-ignore — the dense one-line case layout is intentional and
  // makes the opcode table readable as a table; preserving it requires
  // opting out of prettier's formatting for this single statement.
  // prettier-ignore
  switch (op) {
    case 0x09: do_add16(cpu, "IY", regs.BC); cpu.cycles += 7; return;
    case 0x19: do_add16(cpu, "IY", regs.DE); cpu.cycles += 7; return;
    case 0x29: do_add16(cpu, "IY", regs.IY); cpu.cycles += 7; return;
    case 0x39: do_add16(cpu, "IY", regs.SP); cpu.cycles += 7; return;
    case 0x21:
      regs.IYL = mem.read(regs.PC);
      regs.IYH = mem.read((regs.PC + 1) & 0xffff);
      regs.PC = (regs.PC + 2) & 0xffff;
      cpu.cycles += 6;
      return;
    case 0x22: {
      const nn = fetchNN(cpu);
      mem.write(nn, regs.IYL);
      const wz = (nn + 1) & 0xffff;
      regs.WZ = wz;
      mem.write(wz, regs.IYH);
      cpu.cycles += 12;
      return;
    }
    case 0x2a: {
      const nn = fetchNN(cpu);
      regs.IYL = mem.read(nn);
      const wz = (nn + 1) & 0xffff;
      regs.WZ = wz;
      regs.IYH = mem.read(wz);
      cpu.cycles += 12;
      return;
    }
    case 0x23: regs.IY = (regs.IY + 1) & 0xffff; cpu.cycles += 2; return;
    case 0x2b: regs.IY = (regs.IY - 1) & 0xffff; cpu.cycles += 2; return;

    case 0x24: regs.IYH = inc8(cpu, regs.IYH); return;
    case 0x25: regs.IYH = dec8(cpu, regs.IYH); return;
    case 0x26: regs.IYH = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;
    case 0x2c: regs.IYL = inc8(cpu, regs.IYL); return;
    case 0x2d: regs.IYL = dec8(cpu, regs.IYL); return;
    case 0x2e: regs.IYL = mem.read(regs.PC); regs.PC = (regs.PC + 1) & 0xffff; cpu.cycles += 3; return;

    case 0x34: { const addr = iyDisp(cpu, regs.IY); mem.write(addr, inc8(cpu, mem.read(addr))); cpu.cycles += 7; return; }
    case 0x35: { const addr = iyDisp(cpu, regs.IY); mem.write(addr, dec8(cpu, mem.read(addr))); cpu.cycles += 7; return; }
    case 0x36: { const { addr, n } = iyDispImm(cpu, regs.IY); mem.write(addr, n); cpu.cycles += 3; return; }

    case 0x44: regs.B = regs.IYH; return;
    case 0x45: regs.B = regs.IYL; return;
    case 0x4c: regs.C = regs.IYH; return;
    case 0x4d: regs.C = regs.IYL; return;
    case 0x54: regs.D = regs.IYH; return;
    case 0x55: regs.D = regs.IYL; return;
    case 0x5c: regs.E = regs.IYH; return;
    case 0x5d: regs.E = regs.IYL; return;
    case 0x7c: regs.A = regs.IYH; return;
    case 0x7d: regs.A = regs.IYL; return;

    case 0x60: regs.IYH = regs.B; return;
    case 0x61: regs.IYH = regs.C; return;
    case 0x62: regs.IYH = regs.D; return;
    case 0x63: regs.IYH = regs.E; return;
    case 0x64: return;
    case 0x65: regs.IYH = regs.IYL; return;
    case 0x67: regs.IYH = regs.A; return;
    case 0x68: regs.IYL = regs.B; return;
    case 0x69: regs.IYL = regs.C; return;
    case 0x6a: regs.IYL = regs.D; return;
    case 0x6b: regs.IYL = regs.E; return;
    case 0x6c: regs.IYL = regs.IYH; return;
    case 0x6d: return;
    case 0x6f: regs.IYL = regs.A; return;

    case 0x46: regs.B = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;
    case 0x4e: regs.C = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;
    case 0x56: regs.D = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;
    case 0x5e: regs.E = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;
    case 0x66: regs.H = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;
    case 0x6e: regs.L = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;
    case 0x7e: regs.A = mem.read(iyDisp(cpu, regs.IY)); cpu.cycles += 3; return;

    case 0x70: mem.write(iyDisp(cpu, regs.IY), regs.B); cpu.cycles += 3; return;
    case 0x71: mem.write(iyDisp(cpu, regs.IY), regs.C); cpu.cycles += 3; return;
    case 0x72: mem.write(iyDisp(cpu, regs.IY), regs.D); cpu.cycles += 3; return;
    case 0x73: mem.write(iyDisp(cpu, regs.IY), regs.E); cpu.cycles += 3; return;
    case 0x74: mem.write(iyDisp(cpu, regs.IY), regs.H); cpu.cycles += 3; return;
    case 0x75: mem.write(iyDisp(cpu, regs.IY), regs.L); cpu.cycles += 3; return;
    case 0x77: mem.write(iyDisp(cpu, regs.IY), regs.A); cpu.cycles += 3; return;

    case 0x84: do_add_a(cpu, regs.IYH, false); return;
    case 0x85: do_add_a(cpu, regs.IYL, false); return;
    case 0x86: do_add_a(cpu, mem.read(iyDisp(cpu, regs.IY)), false); cpu.cycles += 3; return;
    case 0x8c: do_add_a(cpu, regs.IYH, true); return;
    case 0x8d: do_add_a(cpu, regs.IYL, true); return;
    case 0x8e: do_add_a(cpu, mem.read(iyDisp(cpu, regs.IY)), true); cpu.cycles += 3; return;
    case 0x94: do_sub_a(cpu, regs.IYH, false); return;
    case 0x95: do_sub_a(cpu, regs.IYL, false); return;
    case 0x96: do_sub_a(cpu, mem.read(iyDisp(cpu, regs.IY)), false); cpu.cycles += 3; return;
    case 0x9c: do_sub_a(cpu, regs.IYH, true); return;
    case 0x9d: do_sub_a(cpu, regs.IYL, true); return;
    case 0x9e: do_sub_a(cpu, mem.read(iyDisp(cpu, regs.IY)), true); cpu.cycles += 3; return;
    case 0xa4: and_a(cpu, regs.IYH); return;
    case 0xa5: and_a(cpu, regs.IYL); return;
    case 0xa6: and_a(cpu, mem.read(iyDisp(cpu, regs.IY))); cpu.cycles += 3; return;
    case 0xac: xor_a(cpu, regs.IYH); return;
    case 0xad: xor_a(cpu, regs.IYL); return;
    case 0xae: xor_a(cpu, mem.read(iyDisp(cpu, regs.IY))); cpu.cycles += 3; return;
    case 0xb4: or_a(cpu, regs.IYH); return;
    case 0xb5: or_a(cpu, regs.IYL); return;
    case 0xb6: or_a(cpu, mem.read(iyDisp(cpu, regs.IY))); cpu.cycles += 3; return;
    case 0xbc: do_cp_a(cpu, regs.IYH); return;
    case 0xbd: do_cp_a(cpu, regs.IYL); return;
    case 0xbe: do_cp_a(cpu, mem.read(iyDisp(cpu, regs.IY))); cpu.cycles += 3; return;

    case 0xe1: regs.IY = pop16(cpu); cpu.cycles += 6; return;
    case 0xe3: {
      const sp = regs.SP;
      const lo = mem.read(sp);
      const hi = mem.read((sp + 1) & 0xffff);
      mem.write((sp + 1) & 0xffff, regs.IYH);
      mem.write(sp, regs.IYL);
      regs.IYL = lo;
      regs.IYH = hi;
      regs.WZ = (hi << 8) | lo;
      cpu.cycles += 15;
      return;
    }
    case 0xe5: push16(cpu, regs.IY); cpu.cycles += 7; return;
    case 0xe9: regs.PC = regs.IY; return;
    case 0xf9: regs.SP = regs.IY; cpu.cycles += 2; return;

    case 0xdd: prefix_dd(cpu); return;
    case 0xed: prefix_ed(cpu); return;
    case 0xfd: prefix_fd(cpu); return;
    case 0xcb: {
      const d = mem.read(regs.PC);
      regs.PC = (regs.PC + 1) & 0xffff;
      const disp = asS8(d);
      regs.WZ = (regs.IY + disp) & 0xffff;
      cpu.prefix = { type: "FDCB", displacement: disp };
      cpu.cycles += 4;
      return;
    }

    default:
      dispatchBase(cpu);
      return;
  }
}

// ---------------------------------------------------------------------------
// DDCB / FDCB dispatchers.
//
// By the time we get here, the prefix-CB transition has already fetched
// the displacement byte and stored IX/IY+d in WZ. The op byte was just
// fetched as a regular MR (runOneOp's M1 branch was skipped because
// prefix.type was DDCB/FDCB).
//
// Encoding is the same as plain CB, but every operation works on
// memory at WZ, and for non-(HL) target slots (0..5, 7) the modified
// value is *also* written into the named register (the undocumented
// "register copy" side-effect). BIT b ignores the slot — same flag set
// regardless, no register write.

function indexedCbWriteCopy(cpu: Z80, slot: number, value: u8): void {
  const regs = cpu.regs;
  // prettier-ignore
  switch (slot) {
    case 0: regs.B = value; return;
    case 1: regs.C = value; return;
    case 2: regs.D = value; return;
    case 3: regs.E = value; return;
    case 4: regs.H = value; return;
    case 5: regs.L = value; return;
    case 6: return; // pure (IX+d) form, no register copy
    case 7: regs.A = value; return;
  }
}

export function dispatchIndexedCB(cpu: Z80): void {
  const regs = cpu.regs;
  const mem = cpu.mem;
  const op = regs.OP;
  const slot = op & 7;
  const subOp = (op >> 3) & 7;
  const group = op >> 6;
  const addr = regs.WZ; // already IX/IY + d from the prefix dispatch

  if (group === 1) {
    // BIT b,(IX+d) — flags only, no write, X/Y from W (high byte of WZ).
    const v = mem.read(addr);
    const isSet = (v & (1 << subOp)) !== 0;
    cpu.updateFlags({
      n: 0,
      pv: !isSet,
      h: 1,
      z: !isSet,
      s: subOp === 7 && isSet ? 1 : 0,
      x: regs.W & FLAG_X,
      y: regs.W & FLAG_Y,
    });
    cpu.cycles += 12;
    return;
  }

  // Read, modify, write, optionally also copy to register.
  const v = mem.read(addr);
  let result: u8;

  if (group === 0) {
    // rotate/shift
    let c: number;
    // prettier-ignore
    switch (subOp) {
      case 0:
        c = (v >> 7) & 1;
        result = ((v << 1) | c) & 0xff;
        break;
      case 1:
        c = v & 1;
        result = ((v >> 1) | (c << 7)) & 0xff;
        break;
      case 2: {
        const carryIn = regs.F & FLAG_C ? 1 : 0;
        c = (v >> 7) & 1;
        result = ((v << 1) | carryIn) & 0xff;
        break;
      }
      case 3: {
        const carryIn = regs.F & FLAG_C ? 0x80 : 0;
        c = v & 1;
        result = ((v >> 1) | carryIn) & 0xff;
        break;
      }
      case 4:
        c = (v >> 7) & 1;
        result = (v << 1) & 0xff;
        break;
      case 5:
        c = v & 1;
        result = ((v >> 1) | (v & 0x80)) & 0xff;
        break;
      case 6:
        c = (v >> 7) & 1;
        result = ((v << 1) | 1) & 0xff;
        break;
      default:
        c = v & 1;
        result = (v >> 1) & 0xff;
        break;
    }
    setShiftFlags(cpu, result, c);
  } else if (group === 2) {
    result = v & ~(1 << subOp) & 0xff;
  } else {
    // group === 3
    result = v | (1 << subOp);
  }

  mem.write(addr, result);
  indexedCbWriteCopy(cpu, slot, result);
  cpu.cycles += 16;
}
