import { describe, expect, it } from "vitest";

import { parseAddrFlag, parseSICount } from "../src/tools.js";

describe("parseSICount", () => {
  it("parses plain decimals", () => {
    expect(parseSICount("0")).toBe(0);
    expect(parseSICount("1500")).toBe(1500);
    expect(parseSICount("1234567")).toBe(1234567);
  });

  it("parses hex via 0x prefix (no SI suffix)", () => {
    expect(parseSICount("0x100")).toBe(0x100);
    expect(parseSICount("0xff")).toBe(0xff);
    expect(parseSICount("0X1000")).toBe(0x1000);
  });

  it("applies the k / K suffix as ×1000", () => {
    expect(parseSICount("1k")).toBe(1_000);
    expect(parseSICount("60k")).toBe(60_000);
    expect(parseSICount("60K")).toBe(60_000);
    expect(parseSICount("1.5k")).toBe(1_500);
  });

  it("applies the M suffix as ×1_000_000", () => {
    expect(parseSICount("50M")).toBe(50_000_000);
    expect(parseSICount("50m")).toBe(50_000_000);
    expect(parseSICount("0.5M")).toBe(500_000);
    expect(parseSICount("200M")).toBe(200_000_000);
  });

  it("applies the G / B suffix as ×1_000_000_000", () => {
    expect(parseSICount("1G")).toBe(1_000_000_000);
    expect(parseSICount("1g")).toBe(1_000_000_000);
    expect(parseSICount("1B")).toBe(1_000_000_000);
    expect(parseSICount("1.5G")).toBe(1_500_000_000);
  });

  it("tolerates whitespace around the value", () => {
    expect(parseSICount("  42M  ")).toBe(42_000_000);
    expect(parseSICount("\t60k\n")).toBe(60_000);
  });

  it("rejects garbage input", () => {
    expect(parseSICount("")).toBeNull();
    expect(parseSICount("   ")).toBeNull();
    expect(parseSICount("abc")).toBeNull();
    expect(parseSICount("50X")).toBeNull(); // unknown suffix
    expect(parseSICount("M")).toBeNull(); // missing number
    expect(parseSICount(undefined)).toBeNull();
  });

  it("preserves negative numbers (so callers can range-check)", () => {
    expect(parseSICount("-5")).toBe(-5);
    expect(parseSICount("-1.5k")).toBe(-1_500);
  });
});

describe("parseAddrFlag (regression — unchanged)", () => {
  it("still parses 0x-prefixed hex", () => {
    expect(parseAddrFlag("0xff")).toBe(0xff);
    expect(parseAddrFlag("0xabcd")).toBe(0xabcd);
  });

  it("still parses bare hex with letters", () => {
    expect(parseAddrFlag("ff")).toBe(0xff);
    expect(parseAddrFlag("abcd")).toBe(0xabcd);
  });

  it("still parses decimal", () => {
    expect(parseAddrFlag("42")).toBe(42);
  });

  it("masks values to u16 range", () => {
    expect(parseAddrFlag("0x10000")).toBe(0);
    expect(parseAddrFlag("0x1ffff")).toBe(0xffff);
  });
});
