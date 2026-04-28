export interface State {
  pc: number;
  sp: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  h: number;
  l: number;
  i: number;
  r: number;
  ei: number;
  wz: number;
  ix: number;
  iy: number;
  af_: number;
  bc_: number;
  de_: number;
  hl_: number;
  im: number;
  p: number;
  q: number;
  iff1: number;
  iff2: number;
  ram: [number, number][];
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
