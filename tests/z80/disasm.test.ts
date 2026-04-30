import { describe, expect, it } from "vitest";

import { disassemble } from "../../src/chips/z80/disasm.js";
import type { u8, u16 } from "../../src/flavours.js";

// Build a reader that returns the bytes from `program` starting at
// `base` and 0xFF elsewhere — saves boilerplate in each test case.
function readerFor(program: u8[], base = 0): (addr: u16) => u8 {
  return (addr) => {
    const i = (addr & 0xffff) - base;
    if (i < 0 || i >= program.length) return 0xff;
    return program[i]!;
  };
}

describe("Z80 disassembler", () => {
  it("decodes single-byte opcodes", () => {
    const r = readerFor([0x00, 0x76, 0xc9]);
    expect(disassemble(r, 0).mnemonic).toBe("NOP");
    expect(disassemble(r, 0).length).toBe(1);
    expect(disassemble(r, 1).mnemonic).toBe("HALT");
    expect(disassemble(r, 2).mnemonic).toBe("RET");
  });

  it("substitutes 16-bit nn", () => {
    // JP 0x1234
    const r = readerFor([0xc3, 0x34, 0x12]);
    const d = disassemble(r, 0);
    expect(d.mnemonic).toBe("JP 0x1234");
    expect(d.length).toBe(3);
  });

  it("substitutes 8-bit n", () => {
    // LD A, 0x42
    const r = readerFor([0x3e, 0x42]);
    const d = disassemble(r, 0);
    expect(d.mnemonic).toBe("LD A,0x42");
    expect(d.length).toBe(2);
  });

  it("renders relative jumps as absolute targets", () => {
    // JR 0x05  at PC=0x100 → target = 0x107
    const r = readerFor([0x18, 0x05], 0x100);
    const d = disassemble(r, 0x100);
    expect(d.mnemonic).toBe("JR 0x0107");
    expect(d.length).toBe(2);
  });

  it("renders backward relative jumps", () => {
    // JR -2 at PC=0x100 → target = 0x100 (tight loop)
    const r = readerFor([0x18, 0xfe], 0x100);
    expect(disassemble(r, 0x100).mnemonic).toBe("JR 0x0100");
  });

  it("decodes ED-prefixed instructions", () => {
    // IM 2: ED 5E
    const r = readerFor([0xed, 0x5e]);
    const d = disassemble(r, 0);
    expect(d.mnemonic).toBe("IM 2");
    expect(d.length).toBe(2);
  });

  it("decodes CB-prefixed instructions", () => {
    // BIT 7,A: CB 7F
    const r = readerFor([0xcb, 0x7f]);
    const d = disassemble(r, 0);
    expect(d.mnemonic).toBe("BIT 7,A");
    expect(d.length).toBe(2);
  });

  it("decodes DD-prefixed indexed instructions with displacement", () => {
    // LD A,(IX+5): DD 7E 05
    const r = readerFor([0xdd, 0x7e, 0x05]);
    const d = disassemble(r, 0);
    expect(d.mnemonic).toBe("LD A,(IX+0x05)");
    expect(d.length).toBe(3);
  });

  it("renders negative IX displacement", () => {
    // LD A,(IX-5): DD 7E FB
    const r = readerFor([0xdd, 0x7e, 0xfb]);
    expect(disassemble(r, 0).mnemonic).toBe("LD A,(IX-0x05)");
  });

  it("decodes DDCB indexed BIT instructions", () => {
    // BIT 4,(IX+0x10): DD CB 10 66
    const r = readerFor([0xdd, 0xcb, 0x10, 0x66]);
    const d = disassemble(r, 0);
    expect(d.mnemonic).toBe("BIT 4,(IX+0x10)");
    expect(d.length).toBe(4);
  });

  it("does not mistake flag mnemonics for n/d placeholders", () => {
    // JP NZ,nn — "nz" must NOT be substituted with the n-placeholder
    // and "z" alone must not match \bd\b either.
    const r = readerFor([0xc2, 0x34, 0x12]);
    expect(disassemble(r, 0).mnemonic).toBe("JP nz,0x1234");
  });

  it("preserves all bytes in the result", () => {
    const r = readerFor([0xcd, 0x78, 0x56]); // CALL 0x5678
    const d = disassemble(r, 0);
    expect(d.bytes).toEqual([0xcd, 0x78, 0x56]);
    expect(d.mnemonic).toBe("CALL 0x5678");
  });
});

describe("Z80 disassembler — symbol resolution", () => {
  // Stub a tiny resolver mapping a couple of addresses to names.
  const resolveLabel = (a: number): string | undefined =>
    ({ 0x5678: "print_string", 0x107: "loop" })[a];

  it("substitutes a label for a CALL nn target", () => {
    const r = readerFor([0xcd, 0x78, 0x56]); // CALL 0x5678
    const d = disassemble(r, 0, { resolveLabel });
    expect(d.mnemonic).toBe("CALL print_string");
    expect(d.length).toBe(3);
  });

  it("substitutes a label for a JR target", () => {
    // JR +5 at PC=0x100 → target 0x107 (= "loop")
    const r = readerFor([0x18, 0x05], 0x100);
    expect(disassemble(r, 0x100, { resolveLabel }).mnemonic).toBe("JR loop");
  });

  it("substitutes a label for a 16-bit LD nn operand", () => {
    // LD HL,0x5678
    const r = readerFor([0x21, 0x78, 0x56]);
    expect(disassemble(r, 0, { resolveLabel }).mnemonic).toBe(
      "LD HL,print_string",
    );
  });

  it("does not substitute when the resolver returns undefined", () => {
    const r = readerFor([0xcd, 0x99, 0x99]); // CALL 0x9999 (no label)
    expect(disassemble(r, 0, { resolveLabel }).mnemonic).toBe("CALL 0x9999");
  });

  it("does not touch 8-bit immediate values", () => {
    // LD A,0x78 — same low byte as a known label, but it's not an
    // address so the resolver shouldn't fire.
    const r = readerFor([0x3e, 0x78]);
    expect(disassemble(r, 0, { resolveLabel }).mnemonic).toBe("LD A,0x78");
  });

  it("works without options (resolveLabel optional)", () => {
    const r = readerFor([0xcd, 0x78, 0x56]);
    expect(disassemble(r, 0).mnemonic).toBe("CALL 0x5678");
  });
});
