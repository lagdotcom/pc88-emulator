// Z80 mnemonic-only tables for the disassembler and the test
// harness. The execution path lives in `ops.ts`'s giant-switch
// dispatchers and the `alu.ts` helpers; this file is purely a
// `code → mnemonic` lookup, kept in table form because the
// HL/IX/IY substitutions (Sean Young's H/L rule for the indexed
// variants) are non-trivial to hand-write 1604 times.
//
// New opcodes added to `ops.ts` need a matching entry here, with
// operand placeholders the disassembler recognises (`n`, `nn`,
// `d`, `(IX+d)`, `(IY+d)`, the flag mnemonics `nz`/`z`/`nc`/...).

import type { u8 } from "../../flavours.js";

export interface OpCode {
  code: u8;
  mnemonic: string;
}

interface RegSet {
  rp: "HL" | "IX" | "IY";
  rh: "H" | "IXH" | "IYH";
  rl: "L" | "IXL" | "IYL";
  addr: "hl" | "ix-d" | "iy-d";
}

const HL_SET: RegSet = { rp: "HL", rh: "H", rl: "L", addr: "hl" };
const IX_SET: RegSet = { rp: "IX", rh: "IXH", rl: "IXL", addr: "ix-d" };
const IY_SET: RegSet = { rp: "IY", rh: "IYH", rl: "IYL", addr: "iy-d" };

const op = (code: u8, mnemonic: string): OpCode => ({ code, mnemonic });

const makeOpTable = (...list: OpCode[]): Record<u8, OpCode> =>
  Object.fromEntries(list.map((o) => [o.code, o]));

function addrMnemonic(set: RegSet): string {
  return set.addr === "hl"
    ? "HL"
    : set.addr === "ix-d"
      ? "IX+d"
      : "IY+d";
}

// prettier-ignore — laid out as one row per opcode for navigability.
function buildOpTable(set: RegSet): Record<u8, OpCode> {
  const am = addrMnemonic(set);
  // prettier-ignore
  return makeOpTable(
    op(0x00, "NOP"),
    op(0x01, "LD BC,nn"),
    op(0x02, "LD (BC),A"),
    op(0x03, "INC BC"),
    op(0x04, "INC B"),
    op(0x05, "DEC B"),
    op(0x06, "LD B,n"),
    op(0x07, "RLCA"),
    op(0x08, "EX AF,AF'"),
    op(0x09, `ADD ${set.rp},BC`),
    op(0x0a, "LD A,(BC)"),
    op(0x0b, "DEC BC"),
    op(0x0c, "INC C"),
    op(0x0d, "DEC C"),
    op(0x0e, "LD C,n"),
    op(0x0f, "RRCA"),

    op(0x10, "DJNZ d"),
    op(0x11, "LD DE,nn"),
    op(0x12, "LD (DE),A"),
    op(0x13, "INC DE"),
    op(0x14, "INC D"),
    op(0x15, "DEC D"),
    op(0x16, "LD D,n"),
    op(0x17, "RLA"),
    op(0x18, "JR d"),
    op(0x19, `ADD ${set.rp},DE`),
    op(0x1a, "LD A,(DE)"),
    op(0x1b, "DEC DE"),
    op(0x1c, "INC E"),
    op(0x1d, "DEC E"),
    op(0x1e, "LD E,n"),
    op(0x1f, "RRA"),

    op(0x20, "JR nz,d"),
    op(0x21, `LD ${set.rp},nn`),
    op(0x22, `LD (nn),${set.rp}`),
    op(0x23, `INC ${set.rp}`),
    op(0x24, `INC ${set.rh}`),
    op(0x25, `DEC ${set.rh}`),
    op(0x26, `LD ${set.rh},n`),
    op(0x27, "DAA"),
    op(0x28, "JR z,d"),
    op(0x29, `ADD ${set.rp},${set.rp}`),
    op(0x2a, `LD ${set.rp},(nn)`),
    op(0x2b, `DEC ${set.rp}`),
    op(0x2c, `INC ${set.rl}`),
    op(0x2d, `DEC ${set.rl}`),
    op(0x2e, `LD ${set.rl},n`),
    op(0x2f, "CPL"),

    op(0x30, "JR nc,d"),
    op(0x31, "LD SP,nn"),
    op(0x32, "LD (nn),A"),
    op(0x33, "INC SP"),
    op(0x34, `INC (${am})`),
    op(0x35, `DEC (${am})`),
    op(0x36, `LD (${am}),n`),
    op(0x37, "SCF"),
    op(0x38, "JR c,d"),
    op(0x39, `ADD ${set.rp},SP`),
    op(0x3a, "LD A,(nn)"),
    op(0x3b, "DEC SP"),
    op(0x3c, "INC A"),
    op(0x3d, "DEC A"),
    op(0x3e, "LD A,n"),
    op(0x3f, "CCF"),

    op(0x40, "LD B,B"),
    op(0x41, "LD B,C"),
    op(0x42, "LD B,D"),
    op(0x43, "LD B,E"),
    op(0x44, `LD B,${set.rh}`),
    op(0x45, `LD B,${set.rl}`),
    op(0x46, `LD B,(${am})`),
    op(0x47, "LD B,A"),
    op(0x48, "LD C,B"),
    op(0x49, "LD C,C"),
    op(0x4a, "LD C,D"),
    op(0x4b, "LD C,E"),
    op(0x4c, `LD C,${set.rh}`),
    op(0x4d, `LD C,${set.rl}`),
    op(0x4e, `LD C,(${am})`),
    op(0x4f, "LD C,A"),

    op(0x50, "LD D,B"),
    op(0x51, "LD D,C"),
    op(0x52, "LD D,D"),
    op(0x53, "LD D,E"),
    op(0x54, `LD D,${set.rh}`),
    op(0x55, `LD D,${set.rl}`),
    op(0x56, `LD D,(${am})`),
    op(0x57, "LD D,A"),
    op(0x58, "LD E,B"),
    op(0x59, "LD E,C"),
    op(0x5a, "LD E,D"),
    op(0x5b, "LD E,E"),
    op(0x5c, `LD E,${set.rh}`),
    op(0x5d, `LD E,${set.rl}`),
    op(0x5e, `LD E,(${am})`),
    op(0x5f, "LD E,A"),

    // 0x60-67: LD H,r — H is destination (swaps to IXH/IYH for indexed).
    // 0x66 (LD H,(HL)) keeps H literal because the (HL) memory operand
    // disqualifies the H/L→IXH/IXL substitution per Sean Young.
    op(0x60, `LD ${set.rh},B`),
    op(0x61, `LD ${set.rh},C`),
    op(0x62, `LD ${set.rh},D`),
    op(0x63, `LD ${set.rh},E`),
    op(0x64, `LD ${set.rh},${set.rh}`),
    op(0x65, `LD ${set.rh},${set.rl}`),
    op(0x66, `LD H,(${am})`),
    op(0x67, `LD ${set.rh},A`),
    op(0x68, `LD ${set.rl},B`),
    op(0x69, `LD ${set.rl},C`),
    op(0x6a, `LD ${set.rl},D`),
    op(0x6b, `LD ${set.rl},E`),
    op(0x6c, `LD ${set.rl},${set.rh}`),
    op(0x6d, `LD ${set.rl},${set.rl}`),
    op(0x6e, `LD L,(${am})`),
    op(0x6f, `LD ${set.rl},A`),

    // 0x70-77: LD (HL),r — (HL) is the memory operand, so r stays
    // literal (the H/L source registers in 0x74/75 do NOT become
    // IXH/IXL).
    op(0x70, `LD (${am}),B`),
    op(0x71, `LD (${am}),C`),
    op(0x72, `LD (${am}),D`),
    op(0x73, `LD (${am}),E`),
    op(0x74, `LD (${am}),H`),
    op(0x75, `LD (${am}),L`),
    op(0x76, "HALT"),
    op(0x77, `LD (${am}),A`),
    op(0x78, "LD A,B"),
    op(0x79, "LD A,C"),
    op(0x7a, "LD A,D"),
    op(0x7b, "LD A,E"),
    op(0x7c, `LD A,${set.rh}`),
    op(0x7d, `LD A,${set.rl}`),
    op(0x7e, `LD A,(${am})`),
    op(0x7f, "LD A,A"),

    op(0x80, "ADD A,B"),
    op(0x81, "ADD A,C"),
    op(0x82, "ADD A,D"),
    op(0x83, "ADD A,E"),
    op(0x84, `ADD A,${set.rh}`),
    op(0x85, `ADD A,${set.rl}`),
    op(0x86, `ADD A,(${am})`),
    op(0x87, "ADD A,A"),
    op(0x88, "ADC A,B"),
    op(0x89, "ADC A,C"),
    op(0x8a, "ADC A,D"),
    op(0x8b, "ADC A,E"),
    op(0x8c, `ADC A,${set.rh}`),
    op(0x8d, `ADC A,${set.rl}`),
    op(0x8e, `ADC A,(${am})`),
    op(0x8f, "ADC A,A"),

    op(0x90, "SUB B"),
    op(0x91, "SUB C"),
    op(0x92, "SUB D"),
    op(0x93, "SUB E"),
    op(0x94, `SUB ${set.rh}`),
    op(0x95, `SUB ${set.rl}`),
    op(0x96, `SUB (${am})`),
    op(0x97, "SUB A"),
    op(0x98, "SBC A,B"),
    op(0x99, "SBC A,C"),
    op(0x9a, "SBC A,D"),
    op(0x9b, "SBC A,E"),
    op(0x9c, `SBC A,${set.rh}`),
    op(0x9d, `SBC A,${set.rl}`),
    op(0x9e, `SBC A,(${am})`),
    op(0x9f, "SBC A,A"),

    op(0xa0, "AND B"),
    op(0xa1, "AND C"),
    op(0xa2, "AND D"),
    op(0xa3, "AND E"),
    op(0xa4, `AND ${set.rh}`),
    op(0xa5, `AND ${set.rl}`),
    op(0xa6, `AND (${am})`),
    op(0xa7, "AND A"),
    op(0xa8, "XOR B"),
    op(0xa9, "XOR C"),
    op(0xaa, "XOR D"),
    op(0xab, "XOR E"),
    op(0xac, `XOR ${set.rh}`),
    op(0xad, `XOR ${set.rl}`),
    op(0xae, `XOR (${am})`),
    op(0xaf, "XOR A"),

    op(0xb0, "OR B"),
    op(0xb1, "OR C"),
    op(0xb2, "OR D"),
    op(0xb3, "OR E"),
    op(0xb4, `OR ${set.rh}`),
    op(0xb5, `OR ${set.rl}`),
    op(0xb6, `OR (${am})`),
    op(0xb7, "OR A"),
    op(0xb8, "CP B"),
    op(0xb9, "CP C"),
    op(0xba, "CP D"),
    op(0xbb, "CP E"),
    op(0xbc, `CP ${set.rh}`),
    op(0xbd, `CP ${set.rl}`),
    op(0xbe, `CP (${am})`),
    op(0xbf, "CP A"),

    op(0xc0, "RET nz"),
    op(0xc1, "POP BC"),
    op(0xc2, "JP nz,nn"),
    op(0xc3, "JP nn"),
    op(0xc4, "CALL nz,nn"),
    op(0xc5, "PUSH BC"),
    op(0xc6, "ADD A,n"),
    op(0xc7, "RST 00"),
    op(0xc8, "RET z"),
    op(0xc9, "RET"),
    op(0xca, "JP z,nn"),
    op(0xcb, "PREFIX CB"),
    op(0xcc, "CALL z,nn"),
    op(0xcd, "CALL nn"),
    op(0xce, "ADC A,n"),
    op(0xcf, "RST 08"),

    op(0xd0, "RET nc"),
    op(0xd1, "POP DE"),
    op(0xd2, "JP nc,nn"),
    op(0xd3, "OUT (n),A"),
    op(0xd4, "CALL nc,nn"),
    op(0xd5, "PUSH DE"),
    op(0xd6, "SUB n"),
    op(0xd7, "RST 10"),
    op(0xd8, "RET c"),
    op(0xd9, "EXX"),
    op(0xda, "JP c,nn"),
    op(0xdb, "IN A,(n)"),
    op(0xdc, "CALL c,nn"),
    op(0xdd, "PREFIX DD"),
    op(0xde, "SBC A,n"),
    op(0xdf, "RST 18"),

    op(0xe0, "RET po"),
    op(0xe1, `POP ${set.rp}`),
    op(0xe2, "JP po,nn"),
    op(0xe3, `EX (SP),${set.rp}`),
    op(0xe4, "CALL po,nn"),
    op(0xe5, `PUSH ${set.rp}`),
    op(0xe6, "AND n"),
    op(0xe7, "RST 20"),
    op(0xe8, "RET pe"),
    op(0xe9, `JP (${set.rp})`),
    op(0xea, "JP pe,nn"),
    op(0xeb, "EX DE,HL"),
    op(0xec, "CALL pe,nn"),
    op(0xed, "PREFIX ED"),
    op(0xee, "XOR n"),
    op(0xef, "RST 28"),

    op(0xf0, "RET p"),
    op(0xf1, "POP AF"),
    op(0xf2, "JP p,nn"),
    op(0xf3, "DI"),
    op(0xf4, "CALL p,nn"),
    op(0xf5, "PUSH AF"),
    op(0xf6, "OR n"),
    op(0xf7, "RST 30"),
    op(0xf8, "RET m"),
    op(0xf9, `LD SP,${set.rp}`),
    op(0xfa, "JP m,nn"),
    op(0xfb, "EI"),
    op(0xfc, "CALL m,nn"),
    op(0xfd, "PREFIX FD"),
    op(0xfe, "CP n"),
    op(0xff, "RST 38"),
  );
}

// CB-prefixed opcode generation: 4 groups of 8 sub-ops × 8 targets.
// Targets are B/C/D/E/H/L/(HL)/A indexed by op & 7.
const CB_OP_NAMES = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SLL", "SRL"];
const CB_TARGETS: ReadonlyArray<string | null> = [
  "B", "C", "D", "E", "H", "L", null, "A",
];

function buildCbTable(set: RegSet): Record<u8, OpCode> {
  const am = addrMnemonic(set);
  const ops: OpCode[] = [];
  for (let code = 0; code < 256; code++) {
    const target = code & 7;
    const reg = CB_TARGETS[target];
    const targetName = reg ?? `(${am})`;

    if (code < 0x40) {
      const opName = CB_OP_NAMES[code >> 3];
      ops.push(op(code, `${opName} ${targetName}`));
    } else if (code < 0x80) {
      const bit = (code >> 3) & 7;
      ops.push(op(code, `BIT ${bit},${targetName}`));
    } else if (code < 0xc0) {
      const bit = (code >> 3) & 7;
      ops.push(op(code, `RES ${bit},${targetName}`));
    } else {
      const bit = (code >> 3) & 7;
      ops.push(op(code, `SET ${bit},${targetName}`));
    }
  }
  return makeOpTable(...ops);
}

// DDCB / FDCB: the operand is always (IX+d) / (IY+d). Non-(HL)
// target slots also carry an undocumented "register copy" side
// effect, surfaced in the mnemonic as `op (IX+d),reg`. BIT b
// ignores the slot (every variant prints as `BIT b,(IX+d)`).
function buildIndexedCbTable(set: RegSet): Record<u8, OpCode> {
  if (set.addr === "hl") {
    throw new Error("buildIndexedCbTable requires an indexed RegSet");
  }
  const ops: OpCode[] = [];
  const rp = set.rp;
  for (let code = 0; code < 256; code++) {
    const target = code & 7;
    const reg = CB_TARGETS[target];
    const regSuffix = reg ? `,${reg}` : "";

    if (code < 0x40) {
      const opName = CB_OP_NAMES[code >> 3];
      ops.push(op(code, `${opName} (${rp}+d)${regSuffix}`));
    } else if (code < 0x80) {
      const bit = (code >> 3) & 7;
      ops.push(op(code, `BIT ${bit},(${rp}+d)`));
    } else if (code < 0xc0) {
      const bit = (code >> 3) & 7;
      ops.push(op(code, `RES ${bit},(${rp}+d)${regSuffix}`));
    } else {
      const bit = (code >> 3) & 7;
      ops.push(op(code, `SET ${bit},(${rp}+d)${regSuffix}`));
    }
  }
  return makeOpTable(...ops);
}

// ED is HL-only — no IX/IY indexed variants in this prefix.
function buildEdTable(): Record<u8, OpCode> {
  // prettier-ignore
  return makeOpTable(
    // 0x40-0x4F
    op(0x40, "IN B,(C)"),
    op(0x41, "OUT (C),B"),
    op(0x42, "SBC HL,BC"),
    op(0x43, "LD (nn),BC"),
    op(0x44, "NEG"),
    op(0x45, "RETN"),
    op(0x46, "IM 0"),
    op(0x47, "LD I,A"),
    op(0x48, "IN C,(C)"),
    op(0x49, "OUT (C),C"),
    op(0x4a, "ADC HL,BC"),
    op(0x4b, "LD BC,(nn)"),
    op(0x4c, "NEG"),
    op(0x4d, "RETI"),
    op(0x4e, "IM 0/1"),
    op(0x4f, "LD R,A"),

    // 0x50-0x5F
    op(0x50, "IN D,(C)"),
    op(0x51, "OUT (C),D"),
    op(0x52, "SBC HL,DE"),
    op(0x53, "LD (nn),DE"),
    op(0x54, "NEG"),
    op(0x55, "RETN"),
    op(0x56, "IM 1"),
    op(0x57, "LD A,I"),
    op(0x58, "IN E,(C)"),
    op(0x59, "OUT (C),E"),
    op(0x5a, "ADC HL,DE"),
    op(0x5b, "LD DE,(nn)"),
    op(0x5c, "NEG"),
    op(0x5d, "RETN"),
    op(0x5e, "IM 2"),
    op(0x5f, "LD A,R"),

    // 0x60-0x6F
    op(0x60, "IN H,(C)"),
    op(0x61, "OUT (C),H"),
    op(0x62, "SBC HL,HL"),
    op(0x63, "LD (nn),HL"),
    op(0x64, "NEG"),
    op(0x65, "RETN"),
    op(0x66, "IM 0"),
    op(0x67, "RRD"),
    op(0x68, "IN L,(C)"),
    op(0x69, "OUT (C),L"),
    op(0x6a, "ADC HL,HL"),
    op(0x6b, "LD HL,(nn)"),
    op(0x6c, "NEG"),
    op(0x6d, "RETN"),
    op(0x6e, "IM 0/1"),
    op(0x6f, "RLD"),

    // 0x70-0x7F
    op(0x70, "IN F,(C)"),
    op(0x71, "OUT (C),0"),
    op(0x72, "SBC HL,SP"),
    op(0x73, "LD (nn),SP"),
    op(0x74, "NEG"),
    op(0x75, "RETN"),
    op(0x76, "IM 1"),
    op(0x77, "NOP"),
    op(0x78, "IN A,(C)"),
    op(0x79, "OUT (C),A"),
    op(0x7a, "ADC HL,SP"),
    op(0x7b, "LD SP,(nn)"),
    op(0x7c, "NEG"),
    op(0x7d, "RETN"),
    op(0x7e, "IM 2"),
    op(0x7f, "NOP"),

    // Block ops
    op(0xa0, "LDI"),
    op(0xa1, "CPI"),
    op(0xa2, "INI"),
    op(0xa3, "OUTI"),
    op(0xa8, "LDD"),
    op(0xa9, "CPD"),
    op(0xaa, "IND"),
    op(0xab, "OUTD"),
    op(0xb0, "LDIR"),
    op(0xb1, "CPIR"),
    op(0xb2, "INIR"),
    op(0xb3, "OTIR"),
    op(0xb8, "LDDR"),
    op(0xb9, "CPDR"),
    op(0xba, "INDR"),
    op(0xbb, "OTDR"),
  );
}

export const opCodes = buildOpTable(HL_SET);
export const cbOpCodes = buildCbTable(HL_SET);
export const edOpCodes = buildEdTable();
export const ddOpCodes = buildOpTable(IX_SET);
export const ddCbOpCodes = buildIndexedCbTable(IX_SET);
export const fdOpCodes = buildOpTable(IY_SET);
export const fdCbOpCodes = buildIndexedCbTable(IY_SET);
