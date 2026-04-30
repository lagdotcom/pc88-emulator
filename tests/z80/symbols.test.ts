import { describe, expect, it } from "vitest";

import {
  emptySymbolFile,
  parseSymbolFile,
  removeSymbol,
  serialiseSymbolFile,
  setSymbol,
  symbolTable,
} from "../../src/chips/z80/symbols.js";

describe("symbol-file parser", () => {
  it("parses md5 header + symbols + comments", () => {
    const text = [
      "# Symbol file for mkI-n88.",
      "# md5: 22be239bc0c4298bc0561252eed98633",
      "",
      "# Banner & print path",
      "0x5550 print_string         ; print NUL-terminated string at HL",
      "0x7968 print_banner_seq",
      "",
      "0x79BE str_n88_banner       ; the banner",
    ].join("\n");

    const f = parseSymbolFile(text, "test.sym");
    expect(f.md5).toBe("22be239bc0c4298bc0561252eed98633");
    expect(f.byAddr.size).toBe(3);
    expect(f.byAddr.get(0x5550)).toEqual({
      addr: 0x5550,
      name: "print_string",
      comment: "print NUL-terminated string at HL",
    });
    expect(f.byAddr.get(0x7968)).toEqual({
      addr: 0x7968,
      name: "print_banner_seq",
    });
    expect(f.byName.get("str_n88_banner")?.addr).toBe(0x79be);
  });

  it("preserves comments and blank lines through round-trip", () => {
    const text =
      [
        "# Header comment",
        "# md5: aabbccdd00112233aabbccdd00112233",
        "",
        "# Section: print path",
        "0x5550 print_string         ; with inline comment",
        "",
        "# Section: data",
        "0x79BE str_banner",
      ].join("\n") + "\n";

    const f = parseSymbolFile(text, "test.sym");
    const out = serialiseSymbolFile(f);
    expect(out).toBe(text);
  });

  it("setSymbol updates an existing entry without re-ordering the file", () => {
    const text = [
      "# Header",
      "",
      "0x1000 alpha               ; first",
      "0x2000 beta                ; second",
      "0x3000 gamma               ; third",
    ].join("\n");
    const f = parseSymbolFile(text, "test.sym");
    setSymbol(f, 0x2000, "BETA_RENAMED");
    const out = serialiseSymbolFile(f);
    // Existing comment preserved, name updated, line position unchanged.
    expect(out).toContain("0x2000 BETA_RENAMED  ; second");
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("BETA_RENAMED"));
    expect(out.indexOf("BETA_RENAMED")).toBeLessThan(out.indexOf("gamma"));
    // byName map updated, old name no longer reachable.
    expect(f.byName.has("beta")).toBe(false);
    expect(f.byName.get("BETA_RENAMED")?.addr).toBe(0x2000);
  });

  it("setSymbol appends a new symbol when none exists at that addr", () => {
    const f = emptySymbolFile("test.sym");
    setSymbol(f, 0x4000, "newone", "with comment");
    expect(f.byAddr.get(0x4000)?.name).toBe("newone");
    expect(serialiseSymbolFile(f)).toContain("0x4000 newone  ; with comment");
  });

  it("removeSymbol drops the line but keeps surrounding comments", () => {
    const text = [
      "# Header",
      "0x1000 keep1",
      "0x2000 dropme              ; goodbye",
      "0x3000 keep2",
    ].join("\n");
    const f = parseSymbolFile(text, "test.sym");
    expect(removeSymbol(f, 0x2000)).toBe(true);
    const out = serialiseSymbolFile(f);
    expect(out).toContain("0x1000 keep1");
    expect(out).toContain("0x3000 keep2");
    expect(out).not.toContain("dropme");
    // Header comment survives.
    expect(out).toContain("# Header");
    expect(f.byAddr.has(0x2000)).toBe(false);
  });

  it("removeSymbol accepts either an address or a name", () => {
    const f = parseSymbolFile("0x1234 foo\n0x5678 bar\n", "test.sym");
    expect(removeSymbol(f, "foo")).toBe(true);
    expect(f.byAddr.has(0x1234)).toBe(false);
    expect(removeSymbol(f, 0x5678)).toBe(true);
    expect(f.byAddr.has(0x5678)).toBe(false);
    expect(removeSymbol(f, "nope")).toBe(false);
  });

  it("symbolTable.lookup returns names for known addresses", () => {
    const f = parseSymbolFile("0x5550 print_string\n", "test.sym");
    const t = symbolTable(f);
    expect(t.lookup(0x5550)).toBe("print_string");
    expect(t.lookup(0x5551)).toBeUndefined();
  });

  it("ignores malformed lines but preserves them as comments on rewrite", () => {
    const text = [
      "0x1000 valid",
      "this line is not a symbol",
      "0x2000 also_valid",
    ].join("\n");
    const f = parseSymbolFile(text, "test.sym");
    expect(f.byAddr.size).toBe(2);
    const out = serialiseSymbolFile(f);
    expect(out).toContain("[unparsed]");
    expect(out).toContain("0x1000 valid");
    expect(out).toContain("0x2000 also_valid");
  });
});
