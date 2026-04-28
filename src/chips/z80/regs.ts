import type { u8, u16 } from "../../flavours.js";

export interface Z80Regs {
  AF: u16;
  A: u8;
  F: u8;
  BC: u16;
  B: u8;
  C: u8;
  DE: u16;
  D: u8;
  E: u8;
  HL: u16;
  H: u8;
  L: u8;

  AF_: u16;
  A_: u8;
  F_: u8;
  BC_: u16;
  B_: u8;
  C_: u8;
  DE_: u16;
  D_: u8;
  E_: u8;
  HL_: u16;
  H_: u8;
  L_: u8;

  IX: u16;
  IXH: u8;
  IXL: u8;
  IY: u16;
  IYH: u8;
  IYL: u8;

  SP: u16;
  SPH: u8;
  SPL: u8;

  IR: u16;
  I: u8;
  R: u8;

  WZ: u16;
  W: u8;
  Z: u8;

  PC: u16;
  PCH: u8;
  PCL: u8;

  OP2: u16;
  OPx: u8;
  OP: u8;
}

export type Reg = keyof Z80Regs;

export type Reg8 =
  | "A"
  | "A_"
  | "F"
  | "F_"
  | "B"
  | "B_"
  | "C"
  | "C_"
  | "D"
  | "D_"
  | "E"
  | "E_"
  | "H"
  | "H_"
  | "L"
  | "L_"
  | "IXH"
  | "IXL"
  | "IYH"
  | "IYL"
  | "SPH"
  | "SPL"
  | "I"
  | "R"
  | "W"
  | "Z"
  | "PCH"
  | "PCL"
  | "OP"
  | "OPx";
export type Reg16 =
  | "AF"
  | "AF_"
  | "BC"
  | "BC_"
  | "DE"
  | "DE_"
  | "HL"
  | "HL_"
  | "IX"
  | "IY"
  | "SP"
  | "IR"
  | "WZ"
  | "PC"
  | "OP2";

// The register file is backed by a 30-byte ArrayBuffer with both u8 and u16
// views. Class accessors give V8 a stable hidden class to optimize against;
// the typed-array backing handles wrap masking automatically. This is
// roughly 5-10x faster than the previous defineProperty-with-closure layout
// because every access becomes a single typed-array index instead of a
// function call through a closure.
//
// Pair layout (little-endian within each pair):
//   AF: F=byte 0, A=byte 1     -> u16 index 0
//   BC: C=byte 2, B=byte 3     -> u16 index 1
//   DE: E=byte 4, D=byte 5     -> u16 index 2
//   HL: L=byte 6, H=byte 7     -> u16 index 3
//   AF_/BC_/DE_/HL_: bytes 8-15
//   IX: IXL=byte 16, IXH=byte 17
//   IY: IYL=byte 18, IYH=byte 19
//   SP: SPL=byte 20, SPH=byte 21
//   IR: R=byte 22,   I=byte 23
//   PC: PCL=byte 24, PCH=byte 25
//   WZ: Z=byte 26,   W=byte 27
//   OP2: OP=byte 28, OPx=byte 29

class Z80RegsImpl implements Z80Regs {
  private buf = new ArrayBuffer(30);
  private u8 = new Uint8Array(this.buf);
  private u16 = new Uint16Array(this.buf);

  // Main register file
  get F(): u8 { return this.u8[0]!; } set F(v: number) { this.u8[0] = v; }
  get A(): u8 { return this.u8[1]!; } set A(v: number) { this.u8[1] = v; }
  get AF(): u16 { return this.u16[0]!; } set AF(v: number) { this.u16[0] = v; }

  get C(): u8 { return this.u8[2]!; } set C(v: number) { this.u8[2] = v; }
  get B(): u8 { return this.u8[3]!; } set B(v: number) { this.u8[3] = v; }
  get BC(): u16 { return this.u16[1]!; } set BC(v: number) { this.u16[1] = v; }

  get E(): u8 { return this.u8[4]!; } set E(v: number) { this.u8[4] = v; }
  get D(): u8 { return this.u8[5]!; } set D(v: number) { this.u8[5] = v; }
  get DE(): u16 { return this.u16[2]!; } set DE(v: number) { this.u16[2] = v; }

  get L(): u8 { return this.u8[6]!; } set L(v: number) { this.u8[6] = v; }
  get H(): u8 { return this.u8[7]!; } set H(v: number) { this.u8[7] = v; }
  get HL(): u16 { return this.u16[3]!; } set HL(v: number) { this.u16[3] = v; }

  // Shadow set
  get F_(): u8 { return this.u8[8]!; } set F_(v: number) { this.u8[8] = v; }
  get A_(): u8 { return this.u8[9]!; } set A_(v: number) { this.u8[9] = v; }
  get AF_(): u16 { return this.u16[4]!; } set AF_(v: number) { this.u16[4] = v; }

  get C_(): u8 { return this.u8[10]!; } set C_(v: number) { this.u8[10] = v; }
  get B_(): u8 { return this.u8[11]!; } set B_(v: number) { this.u8[11] = v; }
  get BC_(): u16 { return this.u16[5]!; } set BC_(v: number) { this.u16[5] = v; }

  get E_(): u8 { return this.u8[12]!; } set E_(v: number) { this.u8[12] = v; }
  get D_(): u8 { return this.u8[13]!; } set D_(v: number) { this.u8[13] = v; }
  get DE_(): u16 { return this.u16[6]!; } set DE_(v: number) { this.u16[6] = v; }

  get L_(): u8 { return this.u8[14]!; } set L_(v: number) { this.u8[14] = v; }
  get H_(): u8 { return this.u8[15]!; } set H_(v: number) { this.u8[15] = v; }
  get HL_(): u16 { return this.u16[7]!; } set HL_(v: number) { this.u16[7] = v; }

  // Index registers
  get IXL(): u8 { return this.u8[16]!; } set IXL(v: number) { this.u8[16] = v; }
  get IXH(): u8 { return this.u8[17]!; } set IXH(v: number) { this.u8[17] = v; }
  get IX(): u16 { return this.u16[8]!; } set IX(v: number) { this.u16[8] = v; }

  get IYL(): u8 { return this.u8[18]!; } set IYL(v: number) { this.u8[18] = v; }
  get IYH(): u8 { return this.u8[19]!; } set IYH(v: number) { this.u8[19] = v; }
  get IY(): u16 { return this.u16[9]!; } set IY(v: number) { this.u16[9] = v; }

  // Stack pointer
  get SPL(): u8 { return this.u8[20]!; } set SPL(v: number) { this.u8[20] = v; }
  get SPH(): u8 { return this.u8[21]!; } set SPH(v: number) { this.u8[21] = v; }
  get SP(): u16 { return this.u16[10]!; } set SP(v: number) { this.u16[10] = v; }

  // Interrupt vector / refresh
  get R(): u8 { return this.u8[22]!; } set R(v: number) { this.u8[22] = v; }
  get I(): u8 { return this.u8[23]!; } set I(v: number) { this.u8[23] = v; }
  get IR(): u16 { return this.u16[11]!; } set IR(v: number) { this.u16[11] = v; }

  // Program counter
  get PCL(): u8 { return this.u8[24]!; } set PCL(v: number) { this.u8[24] = v; }
  get PCH(): u8 { return this.u8[25]!; } set PCH(v: number) { this.u8[25] = v; }
  get PC(): u16 { return this.u16[12]!; } set PC(v: number) { this.u16[12] = v; }

  // MEMPTR (WZ)
  get Z(): u8 { return this.u8[26]!; } set Z(v: number) { this.u8[26] = v; }
  get W(): u8 { return this.u8[27]!; } set W(v: number) { this.u8[27] = v; }
  get WZ(): u16 { return this.u16[13]!; } set WZ(v: number) { this.u16[13] = v; }

  // Internal scratch (the OP / OPx pair, used by the dispatcher and as a
  // temp for read-modify-write sequences without clobbering MEMPTR).
  get OP(): u8 { return this.u8[28]!; } set OP(v: number) { this.u8[28] = v; }
  get OPx(): u8 { return this.u8[29]!; } set OPx(v: number) { this.u8[29] = v; }
  get OP2(): u16 { return this.u16[14]!; } set OP2(v: number) { this.u16[14] = v; }
}

export function makeRegs(): Z80Regs {
  return new Z80RegsImpl();
}

export interface Z80Flags {
  c?: boolean | number;
  n?: boolean | number;
  pv?: boolean | number;
  x?: boolean | number;
  h?: boolean | number;
  y?: boolean | number;
  z?: boolean | number;
  s?: boolean | number;
}

export const FLAG_C: u8 = 0x01;
export const FLAG_N: u8 = 0x02;
export const FLAG_PV: u8 = 0x04;
export const FLAG_X: u8 = 0x08;
export const FLAG_H: u8 = 0x10;
export const FLAG_Y: u8 = 0x20;
export const FLAG_Z: u8 = 0x40;
export const FLAG_S: u8 = 0x80;

export function carry(f: u8) {
  return f & FLAG_C;
}
