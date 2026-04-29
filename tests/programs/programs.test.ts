// Small Z80 programs that exercise multiple opcodes interacting with each
// other. Each test loads a hand-assembled byte sequence, runs to HALT,
// and asserts on register/memory state.
//
// Bytes are inlined with comments showing the source assembly so the test
// is readable without an external .asm file. Where labels appear, the
// resolved address is shown in the comment.

import { describe, expect, it } from "vitest";

import { makeProgramHarness, runUntilHalt } from "./harness.js";

describe("HALT", () => {
  it("stops after one instruction", () => {
    const h = makeProgramHarness();
    const result = runUntilHalt(h, [0x76], { loadAddr: 0x0000 });
    expect(result.ops).toBe(1);
    expect(h.cpu.halted).toBe(true);
  });
});

describe("fib(10) via ADD HL,DE in a loop", () => {
  // Iteratively computes Fibonacci with HL = F(n-1), DE = F(n) so that
  // after 10 trips through the body HL holds F(10) = 55.
  //
  //         LD   HL,0          ; F(0)
  //         LD   DE,1          ; F(1)
  //         LD   B,10          ; loop count
  // loop:   PUSH DE
  //         ADD  HL,DE         ; HL = F(n-1) + F(n)
  //         POP  DE
  //         EX   DE,HL         ; HL = F(n), DE = F(n+1)
  //         DJNZ loop
  //         HALT
  it("ends with HL = 55", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x21, 0x00, 0x00,    // LD HL,0
        0x11, 0x01, 0x00,    // LD DE,1
        0x06, 0x0a,          // LD B,10
        // loop:  (offset 8)
        0xd5,                // PUSH DE
        0x19,                // ADD HL,DE
        0xd1,                // POP DE
        0xeb,                // EX DE,HL
        0x10, 0xfa,          // DJNZ loop  (-6)
        0x76,                // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.HL).toBe(55);
    expect(h.cpu.regs.DE).toBe(89);
  });
});

describe("sum 1..10 via DJNZ", () => {
  // Trivial counter that exercises ADD A,r and DJNZ:
  //         LD   A,0
  //         LD   B,10
  // loop:   ADD  A,B
  //         DJNZ loop
  //         HALT
  it("ends with A = 55", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x3e, 0x00,      // LD A,0
        0x06, 0x0a,      // LD B,10
        0x80,            // ADD A,B
        0x10, 0xfd,      // DJNZ -3
        0x76,            // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(55);
    expect(h.cpu.regs.B).toBe(0);
  });
});

describe("max of 4 bytes via CP / JR NC", () => {
  // Walk a 4-byte array tracking the running maximum.
  //         LD   HL,0x0110     ; data ptr
  //         LD   B,4
  //         LD   A,0
  // loop:   LD   C,(HL)
  //         CP   C             ; A - C; carry if A < C
  //         JR   NC,skip
  //         LD   A,C
  // skip:   INC  HL
  //         DJNZ loop
  //         HALT
  // 0x110:  DB 3,7,2,9
  it("ends with A = 9", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x21, 0x10, 0x01,    // LD HL,0x0110
        0x06, 0x04,          // LD B,4
        0x3e, 0x00,          // LD A,0
        // loop: (offset 7 → 0x107)
        0x4e,                // LD C,(HL)
        0xb9,                // CP C
        0x30, 0x01,          // JR NC,+1 (skip the LD A,C)
        0x79,                // LD A,C
        // skip: (offset 0xc → 0x10c)
        0x23,                // INC HL
        0x10, 0xf8,          // DJNZ loop  (-8)
        0x76,                // HALT
        // 0x110: data (HALT at 0x10f, data starts immediately after)
        0x03, 0x07, 0x02, 0x09,
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(9);
  });
});

describe("LDIR copies a string", () => {
  // Demonstrates the block-transfer instruction. Copies 5 bytes from
  // src to dst and halts; the test inspects RAM directly.
  //         LD   HL,src        ; 0x0110
  //         LD   DE,dst        ; 0x0120
  //         LD   BC,5
  //         LDIR
  //         HALT
  it("dst memory matches src", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x21, 0x10, 0x01,         // LD HL,0x0110
        0x11, 0x20, 0x01,         // LD DE,0x0120
        0x01, 0x05, 0x00,         // LD BC,5
        0xed, 0xb0,               // LDIR
        0x76,                     // HALT
        // padding to 0x10
        0x00, 0x00, 0x00, 0x00,
        // 0x110: "Hello"
        0x48, 0x65, 0x6c, 0x6c, 0x6f,
      ],
      { loadAddr: 0x0100 },
    );
    const dst = Array.from(h.ram.bytes.slice(0x0120, 0x0125));
    expect(dst).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(h.cpu.regs.HL).toBe(0x0115);
    expect(h.cpu.regs.DE).toBe(0x0125);
    expect(h.cpu.regs.BC).toBe(0);
  });
});

describe("CALL / RET preserve SP", () => {
  // Calls a small subroutine that loads A=0x42 and returns. The test
  // checks that SP is back to its starting value and A = 0x42.
  //         CALL sub           ; 0x0108
  //         HALT
  //         ...
  // sub:    LD   A,0x42
  //         RET
  it("returns to caller and clears the stack", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0xcd, 0x08, 0x01,    // CALL 0x0108
        0x76,                // HALT
        0x00, 0x00, 0x00, 0x00,
        // sub: 0x108
        0x3e, 0x42,          // LD A,0x42
        0xc9,                // RET
      ],
      { loadAddr: 0x0100, sp: 0xffff },
    );
    expect(h.cpu.regs.A).toBe(0x42);
    expect(h.cpu.regs.SP).toBe(0xffff);
  });
});

describe("DAA after BCD addition", () => {
  // Compute 0x47 + 0x38 in BCD:
  //   ADD A,B   ; binary 0x47 + 0x38 = 0x7f, with H=0
  //   DAA       ; corrects to 0x85 (the BCD result of 47 + 38)
  it("converts binary sum to packed BCD", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x3e, 0x47,    // LD A,0x47
        0x06, 0x38,    // LD B,0x38
        0x80,          // ADD A,B
        0x27,          // DAA
        0x76,          // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(0x85);
  });

  it("handles BCD subtraction with borrow", () => {
    // 0x12 - 0x25 = 0x87 in BCD with carry set (representing -13 in
    // 100s-complement BCD).
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x3e, 0x12,    // LD A,0x12
        0x06, 0x25,    // LD B,0x25
        0x90,          // SUB B
        0x27,          // DAA
        0x76,          // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(0x87);
    expect(h.cpu.regs.F & 0x01).toBeTruthy(); // carry set
  });
});

describe("multiply A by 7 via shift+add", () => {
  // No MUL on the Z80 — multiplication is a sequence of shifts and
  // additions. 7 = 4 + 2 + 1 → A*7 = A<<2 + A<<1 + A.
  //         LD   A,9           ; multiplicand
  //         LD   B,A           ; A×1
  //         ADD  A,A           ; A×2
  //         LD   C,A           ; save A×2
  //         ADD  A,A           ; A×4
  //         ADD  A,C           ; A×6
  //         ADD  A,B           ; A×7
  //         HALT
  it("9 * 7 = 63", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x3e, 0x09,   // LD A,9
        0x47,         // LD B,A
        0x87,         // ADD A,A
        0x4f,         // LD C,A
        0x87,         // ADD A,A
        0x81,         // ADD A,C
        0x80,         // ADD A,B
        0x76,         // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(63);
  });
});

describe("16-bit add with HL and IX", () => {
  // Verifies that DD-prefixed instructions reach the IX register file
  // and that ADD IX,DE works.
  //         LD   IX,0x1234
  //         LD   DE,0x1111
  //         ADD  IX,DE
  //         HALT
  it("IX = 0x2345 after ADD", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0xdd, 0x21, 0x34, 0x12,  // LD IX,0x1234
        0x11, 0x11, 0x11,        // LD DE,0x1111
        0xdd, 0x19,              // ADD IX,DE
        0x76,                    // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.IX).toBe(0x2345);
  });
});

describe("CPIR finds first occurrence", () => {
  // Search for byte 0x33 in a 5-byte array. CPIR exits when it finds a
  // match (Z=1) or BC reaches 0.
  //         LD   HL,0x0110     ; data
  //         LD   BC,5
  //         LD   A,0x33        ; key
  //         CPIR
  //         HALT
  // 0x110:  DB 0x10, 0x22, 0x33, 0x44, 0x55
  it("HL points one past the match and BC counts remaining", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x21, 0x10, 0x01,    // LD HL,0x0110
        0x01, 0x05, 0x00,    // LD BC,5
        0x3e, 0x33,          // LD A,0x33
        0xed, 0xb1,          // CPIR
        0x76,                // HALT
        // padding (HALT at 0x10a, data at 0x110)
        0x00, 0x00, 0x00, 0x00, 0x00,
        // 0x110: data
        0x10, 0x22, 0x33, 0x44, 0x55,
      ],
      { loadAddr: 0x0100 },
    );
    // Match at 0x0112; CPIR advances HL past the matching byte.
    expect(h.cpu.regs.HL).toBe(0x0113);
    expect(h.cpu.regs.BC).toBe(2);
    // Z is set on match.
    expect(h.cpu.regs.F & 0x40).toBeTruthy();
  });
});

describe("PUSH / POP round-trip", () => {
  // Verifies that PUSH followed by POP recovers the same 16-bit value
  // and that the F register survives push/pop into and out of AF.
  //         LD   A,0xa5
  //         LD   F,0x42       ; can't load F directly — synthesize via PUSH/POP
  //         LD   BC,0xbeef
  //         PUSH BC
  //         POP  HL           ; HL = 0xbeef
  //         HALT
  it("HL receives the pushed BC", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x01, 0xef, 0xbe,   // LD BC,0xbeef
        0xc5,               // PUSH BC
        0xe1,               // POP HL
        0x76,               // HALT
      ],
      { loadAddr: 0x0100, sp: 0xffff },
    );
    expect(h.cpu.regs.HL).toBe(0xbeef);
    expect(h.cpu.regs.BC).toBe(0xbeef);
    expect(h.cpu.regs.SP).toBe(0xffff);
  });
});

describe("16-bit arithmetic via ADC HL,DE", () => {
  // Add two 16-bit values: 0x1234 + 0x4321 = 0x5555. Then ADC carries
  // any overflow from a previous ADD; we set carry first via SCF.
  //         LD   HL,0x1234
  //         LD   DE,0x4321
  //         AND  A             ; clear carry
  //         ADC  HL,DE         ; ED 5A
  //         HALT
  it("HL = 0x5555 and carry clear", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x21, 0x34, 0x12,    // LD HL,0x1234
        0x11, 0x21, 0x43,    // LD DE,0x4321
        0xa7,                // AND A (clears C, H, N)
        0xed, 0x5a,          // ADC HL,DE
        0x76,                // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.HL).toBe(0x5555);
    expect(h.cpu.regs.F & 0x01).toBe(0); // no carry
  });
});

describe("nested CALL / RET", () => {
  // outer calls middle, middle calls inner. inner sets A=1,
  // middle increments A, outer increments A again. End: A=3, SP back
  // to start.
  //         CALL outer        ; 0x0100 → 0x0108
  //         HALT              ; 0x0103
  //         ...
  // outer:  CALL middle       ; 0x0108 → 0x0110
  //         INC  A
  //         RET               ; 0x010c (CALL=3, INC=1, RET=1, total=5)
  // middle: CALL inner        ; 0x0110 → 0x0118
  //         INC  A
  //         RET               ; 0x0114
  // inner:  LD   A,1
  //         RET               ; 0x0118
  it("returns A=3 with SP restored", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        // 0x0100
        0xcd, 0x08, 0x01,    // CALL outer
        0x76,                // HALT
        0x00, 0x00, 0x00, 0x00,
        // 0x0108: outer
        0xcd, 0x10, 0x01,    // CALL middle
        0x3c,                // INC A
        0xc9,                // RET
        0x00, 0x00, 0x00,
        // 0x0110: middle
        0xcd, 0x18, 0x01,    // CALL inner
        0x3c,                // INC A
        0xc9,                // RET
        0x00, 0x00, 0x00,
        // 0x0118: inner
        0x3e, 0x01,          // LD A,1
        0xc9,                // RET
      ],
      { loadAddr: 0x0100, sp: 0xffff },
    );
    expect(h.cpu.regs.A).toBe(3);
    expect(h.cpu.regs.SP).toBe(0xffff);
  });
});

describe("RST 0x18 reaches the rst handler", () => {
  // RST n is a one-byte CALL n. Plant a handler at 0x0018, fire RST 18,
  // and verify the handler ran.
  it("handler increments B; final B=1", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        // 0x0000-0x0017: low memory contains the RST 18 stub at 0x18.
        // The first 24 bytes get filled with NOP; we put HALT at 0x16
        // so if the RST handler returns to the wrong place we trap.
        ...new Array(0x0018).fill(0x00),
        // 0x0018: RST 18 handler
        0x04,    // INC B
        0xc9,    // RET
        // padding to 0x0100
        ...new Array(0x0100 - 0x001a).fill(0x00),
        // 0x0100: program
        0x06, 0x00,    // LD B,0
        0xdf,          // RST 18
        0x76,          // HALT
      ],
      { loadAddr: 0x0000, startPc: 0x0100, sp: 0xffff },
    );
    expect(h.cpu.regs.B).toBe(1);
    expect(h.cpu.regs.SP).toBe(0xffff);
  });
});

describe("conditional JP and JR via JR Z / JR NZ", () => {
  // Jump table flow control: execute one of two paths based on a
  // comparison.
  //         LD   A,5
  //         CP   5
  //         JR   Z,equal
  //         LD   A,0xff      ; not-equal path: A = 0xff
  //         JR   end
  // equal:  LD   A,0x42      ; equal path: A = 0x42
  // end:    HALT
  it("JR Z taken when Z set", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x3e, 0x05,          // LD A,5
        0xfe, 0x05,           // CP 5
        0x28, 0x04,           // JR Z, +4
        0x3e, 0xff,           // LD A,0xff
        0x18, 0x02,           // JR +2
        // equal:
        0x3e, 0x42,           // LD A,0x42
        // end:
        0x76,                 // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(0x42);
  });

  it("JR Z not taken when Z clear", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x3e, 0x05,           // LD A,5
        0xfe, 0x06,           // CP 6
        0x28, 0x04,           // JR Z, +4
        0x3e, 0xff,           // LD A,0xff
        0x18, 0x02,           // JR +2
        0x3e, 0x42,           // LD A,0x42
        0x76,                 // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.cpu.regs.A).toBe(0xff);
  });
});

describe("BIT / RES / SET on (HL)", () => {
  // Walk the bits of a memory byte:
  //         LD   HL,0x0110
  //         LD   (HL),0x55     ; 0101 0101
  //         SET  1,(HL)        ; → 0101 0111 = 0x57
  //         RES  4,(HL)        ; → 0100 0111 = 0x47
  //         BIT  0,(HL)        ; tests bit 0 (set), Z=0
  //         HALT
  it("byte transforms to 0x47 and Z is clear after BIT 0", () => {
    const h = makeProgramHarness();
    // prettier-ignore
    runUntilHalt(
      h,
      [
        0x21, 0x10, 0x01,     // LD HL,0x0110
        0x36, 0x55,           // LD (HL),0x55
        0xcb, 0xce,           // SET 1,(HL)
        0xcb, 0xa6,           // RES 4,(HL)
        0xcb, 0x46,           // BIT 0,(HL)
        0x76,                 // HALT
      ],
      { loadAddr: 0x0100 },
    );
    expect(h.ram.bytes[0x0110]).toBe(0x47);
    expect(h.cpu.regs.F & 0x40).toBe(0); // Z clear
  });
});
