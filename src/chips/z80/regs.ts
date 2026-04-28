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

export function makeRegs(): Z80Regs {
  const storage = new ArrayBuffer(30); // TODO
  const view = new DataView(storage);

  const regs = { storage, view };

  function addPair(index: number, pair: Reg16, lo: Reg8, hi: Reg8) {
    Object.defineProperties(regs, {
      [pair]: {
        get: (): u16 => view.getUint16(index, true),
        set: (value: number) => view.setUint16(index, value, true),
      },
      [lo]: {
        get: (): u8 => view.getUint8(index),
        set: (value: number) => view.setUint8(index, value),
      },
      [hi]: {
        get: (): u8 => view.getUint8(index + 1),
        set: (value: number) => view.setUint8(index + 1, value),
      },
    });

    return index + 2;
  }

  let offset = 0;
  offset = addPair(offset, "AF", "F", "A");
  offset = addPair(offset, "BC", "C", "B");
  offset = addPair(offset, "DE", "E", "D");
  offset = addPair(offset, "HL", "L", "H");
  offset = addPair(offset, "AF_", "F_", "A_");
  offset = addPair(offset, "BC_", "C_", "B_");
  offset = addPair(offset, "DE_", "E_", "D_");
  offset = addPair(offset, "HL_", "L_", "H_");
  offset = addPair(offset, "IX", "IXL", "IXH");
  offset = addPair(offset, "IY", "IYL", "IYH");
  offset = addPair(offset, "SP", "SPL", "SPH");
  offset = addPair(offset, "IR", "R", "I");
  offset = addPair(offset, "PC", "PCL", "PCH");
  offset = addPair(offset, "WZ", "Z", "W");
  addPair(offset, "OP2", "OP", "OPx");

  return regs as unknown as Z80Regs;
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
