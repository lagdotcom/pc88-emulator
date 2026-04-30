// Z80 disassembler. Re-uses the mnemonic strings already attached to
// every OpCode in `ops.ts` (e.g. "LD A,n", "JP nz,nn", "BIT 4,(IX+d)")
// and substitutes the placeholders `n` / `nn` / `d` / `(IX+d)` /
// `(IY+d)` with the actual bytes read from memory at `pc`. That way
// new opcodes added to the execution tables get disassembly for free.
//
// Length is derived from how many placeholders the mnemonic contains
// — we don't need to count MR cycles. The placeholder grammar is
// simple enough that a handful of regexes covers every legal case;
// see operandSpec().

import type { Bytes, s8, u8, u16 } from "../../flavours.js";
import {
  cbOpCodes,
  ddCbOpCodes,
  ddOpCodes,
  edOpCodes,
  fdCbOpCodes,
  fdOpCodes,
  type OpCode,
  opCodes,
} from "./ops.js";

export interface DisasmResult {
  // Formatted mnemonic with operand bytes substituted (e.g.
  // "LD A,0x42" or "JR 0x023b" or "BIT 5,(IX+0x10)"). When a
  // SymbolTable is supplied to disassemble() and the resolved
  // address has a label, the hex literal is replaced with the
  // label name.
  readonly mnemonic: string;
  // Total instruction length in bytes (1-4).
  readonly length: Bytes;
  // Raw bytes the instruction consumed, in PC order.
  readonly bytes: u8[];
}

export type DisasmReader = (addr: u16) => u8;

// Optional symbol-resolution callback. Called by disassemble() with
// every absolute address the instruction would jump-to / call /
// load — JR/JP/CALL targets and `LD HL,nn` / `LD A,(nn)` / etc.
// Returning a string substitutes the label for the hex literal;
// returning undefined keeps the literal.
export type ResolveLabel = (addr: u16) => string | undefined;

// Optional port-resolution callback. Called for the immediate `n`
// operand of `IN A,(n)` and `OUT (n),A` instructions. Other `n`
// operands are kept as hex literals because they're values, not
// port numbers. `IN r,(C)` / `OUT (C),r` are register-indirect and
// don't have an immediate to resolve.
export type ResolvePort = (port: u8) => string | undefined;

export interface DisasmOptions {
  resolveLabel?: ResolveLabel;
  resolvePort?: ResolvePort;
}

function hex2(b: number): string {
  return "0x" + (b & 0xff).toString(16).padStart(2, "0");
}

function hex4(w: number): string {
  return "0x" + (w & 0xffff).toString(16).padStart(4, "0");
}

// Format an unsigned byte as a signed offset for IX/IY indexing:
// "+0x05" for positive, "-0x05" for negative. Matches the convention
// most Z80 disassemblers use.
function signedDisp(b: s8): string {
  const sd = (b & 0x80) !== 0 ? b - 256 : b;
  return sd >= 0 ? `+${hex2(sd)}` : `-${hex2(-sd)}`;
}

interface OperandSpec {
  // Total operand bytes the mnemonic asks for, in the order the CPU
  // would read them: indexed displacement first (for plain DD/FD ops),
  // then 16-bit nn (low/high), then standalone n, then JR-style d.
  total: Bytes;
  hasIxD: boolean;
  hasIyD: boolean;
  hasNN: boolean;
  hasN: boolean;
  hasJrD: boolean;
}

// Parse a mnemonic template into an operand specification. The
// per-placeholder flags drive both length calculation and the
// fillTemplate() substitution pass.
function operandSpec(template: string): OperandSpec {
  const hasIxD = /\(IX\+d\)/.test(template);
  const hasIyD = /\(IY\+d\)/.test(template);
  const hasNN = /\bnn\b/.test(template);
  // `n` is a placeholder only when it's word-bounded and not part of
  // a flag mnemonic ("nz", "nc"). \bn\b naturally excludes those
  // because the boundary inside "nz" / "nc" is between two word
  // characters and therefore not a \b match.
  const hasN = /\bn\b/.test(template);
  // Standalone `d` for JR/DJNZ relative jumps. Strip any IX/IY
  // displacement first so we don't double-count the `d` inside
  // "(IX+d)".
  const stripped = template.replace(/\(I[XY]\+d\)/g, "");
  const hasJrD = /\bd\b/.test(stripped);
  let total = 0;
  if (hasIxD || hasIyD) total += 1;
  if (hasNN) total += 2;
  if (hasN) total += 1;
  if (hasJrD) total += 1;
  return { total, hasIxD, hasIyD, hasNN, hasN, hasJrD };
}

// Substitute placeholders in `template` with formatted operand bytes.
// `dispOverride` lets DDCB/FDCB callers supply the displacement
// byte from a fixed position (PC+2) instead of consuming it from
// `operands[0]` — DDCB byte order is `DD CB d opc` so the
// displacement comes BEFORE the opcode rather than after.
// Format an absolute address as either its label (when the resolver
// supplies one) or as a 4-digit hex literal. Used everywhere we
// have a CPU-side address that the user might recognise.
function fmtAddr(addr: u16, resolve: ResolveLabel | undefined): string {
  const a = addr & 0xffff;
  const label = resolve?.(a);
  return label ?? hex4(a);
}

function fillTemplate(
  template: string,
  pc: u16,
  length: Bytes,
  operands: u8[],
  opts: {
    dispOverride?: number | undefined;
    resolve?: ResolveLabel | undefined;
    resolvePort?: ResolvePort | undefined;
  } = {},
): string {
  let m = template;
  let i = 0;

  if (/\(IX\+d\)/.test(m)) {
    const d = opts.dispOverride ?? operands[i++]!;
    m = m.replace(/\(IX\+d\)/g, `(IX${signedDisp(d)})`);
  }
  if (/\(IY\+d\)/.test(m)) {
    const d = opts.dispOverride ?? operands[i++]!;
    m = m.replace(/\(IY\+d\)/g, `(IY${signedDisp(d)})`);
  }
  if (/\bnn\b/.test(m)) {
    const lo = operands[i++]!;
    const hi = operands[i++]!;
    // 16-bit operands are addresses for JP/CALL/LD HL,nn/etc;
    // resolve to a label when one exists.
    m = m.replace(/\bnn\b/, fmtAddr((hi << 8) | lo, opts.resolve));
  }
  if (/\bn\b/.test(m)) {
    const v = operands[i++]!;
    // 8-bit `n` is usually an immediate value, but for IN/OUT the
    // mnemonic is `IN A,(n)` / `OUT (n),A` and the byte is the
    // port number — those get the port resolver instead. Detect
    // by literal "(n)" parens in the template.
    const isPort = /\(n\)/.test(m);
    const portLabel = isPort ? opts.resolvePort?.(v) : undefined;
    m = m.replace(/\bn\b/, portLabel ?? hex2(v));
  }
  // JR/DJNZ relative `d` — render as the absolute target so the
  // user doesn't have to do PC arithmetic in their head. Done last
  // because earlier substitutions can leave their own hex literals
  // in the string and we don't want to match `d` inside e.g. "0xde".
  const afterIx = m.replace(/\(I[XY][+-]0x[0-9a-f]+\)/gi, "");
  if (/\bd\b/.test(afterIx)) {
    const d = operands[i++]!;
    const sd = (d & 0x80) !== 0 ? d - 256 : d;
    const target = (pc + length + sd) & 0xffff;
    m = m.replace(/\bd\b/, fmtAddr(target, opts.resolve));
  }
  return m;
}

function lookup(
  table: Record<u8, OpCode | undefined>,
  code: u8,
): string | undefined {
  return table[code & 0xff]?.mnemonic;
}

// Decode a single instruction starting at `pc`. Walks DD/FD/CB/ED
// prefix chains and returns the formatted mnemonic + total byte
// length so callers can advance `pc` to the next instruction.
//
// Unknown / illegal opcodes produce a "??  XX" mnemonic with the raw
// hex byte so the caller still sees something useful.
//
// Pass `opts.resolveLabel` to substitute label names for the absolute
// addresses in JP/CALL/JR targets and 16-bit `nn` operands. When
// the resolver returns undefined for an address, the hex literal is
// emitted as before, so passing or omitting the option never breaks
// any other formatting.
export function disassemble(
  read: DisasmReader,
  pc: u16,
  opts: DisasmOptions = {},
): DisasmResult {
  const resolve = opts.resolveLabel;
  const resolvePort = opts.resolvePort;
  const b0 = read(pc & 0xffff) & 0xff;
  const bytes: u8[] = [b0];

  // DD / FD prefix (or the doubly-prefixed DDCB / FDCB).
  if (b0 === 0xdd || b0 === 0xfd) {
    const isDd = b0 === 0xdd;
    const b1 = read((pc + 1) & 0xffff) & 0xff;
    bytes.push(b1);

    if (b1 === 0xcb) {
      // DDCB / FDCB: 4-byte instruction `DD/FD CB d opc`.
      const d = read((pc + 2) & 0xffff) & 0xff;
      const opc = read((pc + 3) & 0xffff) & 0xff;
      bytes.push(d, opc);
      const template =
        lookup(isDd ? ddCbOpCodes : fdCbOpCodes, opc) ?? `??  ${hex2(opc)}`;
      const m = fillTemplate(template, pc, 4, [], { dispOverride: d, resolve, resolvePort });
      return { mnemonic: m, length: 4, bytes };
    }

    const template = lookup(isDd ? ddOpCodes : fdOpCodes, b1);
    if (!template) {
      return {
        mnemonic: `??  ${isDd ? "DD" : "FD"} ${hex2(b1)}`,
        length: 2,
        bytes,
      };
    }
    const spec = operandSpec(template);
    const operands: u8[] = [];
    for (let i = 0; i < spec.total; i++) {
      const b = read((pc + 2 + i) & 0xffff) & 0xff;
      operands.push(b);
      bytes.push(b);
    }
    const length = 2 + spec.total;
    return {
      mnemonic: fillTemplate(template, pc, length, operands, { resolve, resolvePort }),
      length,
      bytes,
    };
  }

  // CB / ED single prefix — 2-byte opcode (no further operands for CB,
  // possibly nn-style operands for ED).
  if (b0 === 0xcb || b0 === 0xed) {
    const b1 = read((pc + 1) & 0xffff) & 0xff;
    bytes.push(b1);
    const template = lookup(b0 === 0xcb ? cbOpCodes : edOpCodes, b1);
    if (!template) {
      return {
        mnemonic: `??  ${b0 === 0xcb ? "CB" : "ED"} ${hex2(b1)}`,
        length: 2,
        bytes,
      };
    }
    const spec = operandSpec(template);
    const operands: u8[] = [];
    for (let i = 0; i < spec.total; i++) {
      const b = read((pc + 2 + i) & 0xffff) & 0xff;
      operands.push(b);
      bytes.push(b);
    }
    const length = 2 + spec.total;
    return {
      mnemonic: fillTemplate(template, pc, length, operands, { resolve, resolvePort }),
      length,
      bytes,
    };
  }

  // Base.
  const template = lookup(opCodes, b0);
  if (!template) {
    return { mnemonic: `??  ${hex2(b0)}`, length: 1, bytes };
  }
  const spec = operandSpec(template);
  const operands: u8[] = [];
  for (let i = 0; i < spec.total; i++) {
    const b = read((pc + 1 + i) & 0xffff) & 0xff;
    operands.push(b);
    bytes.push(b);
  }
  const length = 1 + spec.total;
  return {
    mnemonic: fillTemplate(template, pc, length, operands, { resolve, resolvePort }),
    length,
    bytes,
  };
}
