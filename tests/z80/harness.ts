import { Z80 } from "../../src/chips/z80/cpu.js";
import { IOBus } from "../../src/core/IOBus.js";
import { MemoryBus } from "../../src/core/MemoryBus.js";
import type { u8, u16 } from "../../src/flavours.js";
import { RAM64k, TestIO } from "../tools.testHelpers.js";
import type { State, TestCase } from "./types.js";

export interface Harness {
  cpu: Z80;
  ram: RAM64k;
  io: TestIO;
}

export function makeHarness(): Harness {
  const ram = new RAM64k();
  const io = new TestIO();
  const memBus = new MemoryBus([ram], 0xff);
  const ioBus = new IOBus();
  ioBus.registerAll({ name: io.name, read: io.read, write: io.write });
  const cpu = new Z80(memBus, ioBus);
  if (process.env.DISPATCH === "table") cpu.useDispatchBase = false;
  return { cpu, ram, io };
}

export function loadState(h: Harness, st: State): void {
  const { cpu, ram, io } = h;
  cpu.regs.PC = st.pc;
  cpu.regs.SP = st.sp;
  cpu.regs.A = st.a;
  cpu.regs.F = st.f;
  cpu.regs.B = st.b;
  cpu.regs.C = st.c;
  cpu.regs.D = st.d;
  cpu.regs.E = st.e;
  cpu.regs.H = st.h;
  cpu.regs.L = st.l;
  cpu.regs.IX = st.ix;
  cpu.regs.IY = st.iy;
  cpu.regs.AF_ = st.af_;
  cpu.regs.BC_ = st.bc_;
  cpu.regs.DE_ = st.de_;
  cpu.regs.HL_ = st.hl_;
  cpu.regs.I = st.i;
  cpu.regs.R = st.r;
  cpu.regs.WZ = st.wz;
  cpu.iff1 = !!st.iff1;
  cpu.iff2 = !!st.iff2;
  cpu.im = st.im;
  cpu.eiDelay = !!st.ei;
  cpu.q = st.q;
  cpu.qWritten = false;
  cpu.cycles = 0;
  cpu.halted = false;
  cpu.prefix = undefined;

  ram.bytes.fill(0);
  for (const [addr, value] of st.ram) ram.bytes[addr] = value;

  io.inputs.clear();
  io.writes.length = 0;
}

export interface DumpedState {
  pc: u16;
  sp: u16;
  a: u8;
  f: u8;
  b: u8;
  c: u8;
  d: u8;
  e: u8;
  h: u8;
  l: u8;
  i: u8;
  r: u8;
  wz: u16;
  ix: u16;
  iy: u16;
  af_: u16;
  bc_: u16;
  de_: u16;
  hl_: u16;
  im: number;
  iff1: number;
  iff2: number;
  ei: number;
}

export function dumpState(h: Harness): DumpedState {
  const { cpu } = h;
  return {
    pc: cpu.regs.PC,
    sp: cpu.regs.SP,
    a: cpu.regs.A,
    f: cpu.regs.F,
    b: cpu.regs.B,
    c: cpu.regs.C,
    d: cpu.regs.D,
    e: cpu.regs.E,
    h: cpu.regs.H,
    l: cpu.regs.L,
    i: cpu.regs.I,
    r: cpu.regs.R,
    wz: cpu.regs.WZ,
    ix: cpu.regs.IX,
    iy: cpu.regs.IY,
    af_: cpu.regs.AF_,
    bc_: cpu.regs.BC_,
    de_: cpu.regs.DE_,
    hl_: cpu.regs.HL_,
    im: cpu.im,
    iff1: cpu.iff1 ? 1 : 0,
    iff2: cpu.iff2 ? 1 : 0,
    ei: cpu.eiDelay ? 1 : 0,
  };
}

const REG_KEYS = [
  "pc",
  "sp",
  "a",
  "f",
  "b",
  "c",
  "d",
  "e",
  "h",
  "l",
  "i",
  "r",
  "wz",
  "ix",
  "iy",
  "af_",
  "bc_",
  "de_",
  "hl_",
  "im",
  "iff1",
  "iff2",
  "ei",
] as const;

export interface DiffOptions {
  // Register keys to skip when comparing. Defaults to none.
  skipRegs?: ReadonlySet<string>;
  // Skip RAM compare.
  skipRam?: boolean;
}

export interface Diff {
  reg?: string;
  ramAddr?: u16;
  got: number;
  want: number;
}

export function diffState(
  h: Harness,
  expected: State,
  opts: DiffOptions = {},
): Diff[] {
  const got = dumpState(h);
  const skip = opts.skipRegs ?? new Set<string>();
  const diffs: Diff[] = [];

  for (const k of REG_KEYS) {
    if (skip.has(k)) continue;
    const want = expected[k];
    const have = got[k];
    if (want !== have) diffs.push({ reg: k, got: have, want });
  }

  if (!opts.skipRam) {
    for (const [addr, want] of expected.ram) {
      const have = h.ram.bytes[addr]!;
      if (have !== want) diffs.push({ ramAddr: addr, got: have, want });
    }
  }

  return diffs;
}

// Steps the CPU until one full instruction has been dispatched. Each
// runOneOp consumes one byte; if the byte was a prefix the cpu.prefix
// field is left set, telling us to keep going. The dispatch of a
// prefixed opcode clears the prefix on its way out (see decode() in
// cpu.ts), so an iteration that ends with prefix === undefined means
// the whole instruction has been consumed.
export function step(h: Harness): void {
  const { cpu } = h;
  for (let guard = 0; guard < 5; guard++) {
    cpu.runOneOp();
    if (cpu.prefix === undefined) break;
  }
  // Defensive: clear lingering prefix between tests so the next loadState
  // starts clean even if the CPU forgot to clear it.
  cpu.prefix = undefined;
}

// Pre-populates I/O reads from a TestCase's port list so that the CPU's
// IN instructions return the values the test expects.
export function seedPorts(h: Harness, tc: TestCase): void {
  if (!tc.ports) return;
  for (const [port, value, kind] of tc.ports) {
    if (kind === "r") h.io.enqueueInput(port, value);
  }
}
