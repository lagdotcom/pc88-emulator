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

import { asS8 } from "../../numbers.js";
import type { Z80 } from "./cpu.js";
import {
  and_a,
  ccf,
  cpl,
  daa,
  dec8,
  di,
  do_add16,
  do_add_a,
  do_cp_a,
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
} from "./ops.js";
import { FLAG_C, FLAG_PV, FLAG_S, FLAG_Z } from "./regs.js";

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
