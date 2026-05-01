import type { u8, u16 } from "../../src/flavours.js";

export interface State {
  pc: u16;
  sp: u16;
  a: u8;
  b: u8;
  c: u8;
  d: u8;
  e: u8;
  f: u8;
  h: u8;
  l: u8;
  i: u8;
  r: u8;
  ei: number;
  wz: u16;
  ix: u16;
  iy: u16;
  af_: u16;
  bc_: u16;
  de_: u16;
  hl_: u16;
  im: number;
  p: number;
  q: number;
  iff1: number;
  iff2: number;
  ram: [u16, u8][];
}

export type CycleType = string;
export type Cycle = [number, number | null, CycleType];
export type PortKind = "r" | "w";
export type Port = [number, number, PortKind];

export interface TestCase {
  name: string;
  initial: State;
  final: State;
  cycles: Cycle[];
  ports?: Port[];
}
