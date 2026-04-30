// Frank Cringle's zexdoc / zexall — the canonical Z80 instruction-set
// exerciser. Each variant runs ~~9 KB of Z80 code that computes per-test
// CRC values and checks them against expected.
//
//   zexdoc — tests documented behaviour only (~half an hour real-time)
//   zexall — tests documented + undocumented X/Y/H/PV quirks (longer)
//
// The .com binaries are public domain but several MB to commit; this
// test caches them to tests/programs/fixtures/ on first run. Set
// ZEX_URL_ZEXDOC / ZEX_URL_ZEXALL to override the default mirror, or
// drop zexdoc.com / zexall.com into the fixtures directory by hand.
//
// The full run takes a long time (tens of millions of Z80 instructions).
// These tests are gated behind ZEX=1 so the default `yarn test:z80`
// stays fast; run them with `yarn test:zex`.

import { describe, expect, it } from "vitest";

import { minutesToMs } from "../../src/flavour.makers.js";
import { makeProgramHarness, runCpm } from "./harness.js";
import {
  APPROX_TOTAL_OPS,
  loadZEXBinary,
  MAX_OPS,
  SHOW_PROGRESS_EVERY_OPS,
} from "./zex.js";

const SKIP = process.env.ZEX !== "1";

const ZEX_TIMEOUT = minutesToMs(15);

describe.skipIf(SKIP)("zexdoc", () => {
  it(
    "all documented-behaviour CRCs match",
    { timeout: ZEX_TIMEOUT },
    async () => {
      const bin = await loadZEXBinary("zexdoc.com");
      if (!bin) {
        console.warn(
          "zexdoc.com not available; drop the binary into " +
            "tests/programs/fixtures/zexdoc.com or set ZEX_URL_ZEXDOC_COM",
        );
        return;
      }
      const h = makeProgramHarness();
      const r = runCpm(h, bin, {
        maxOps: MAX_OPS,
        progressEvery: SHOW_PROGRESS_EVERY_OPS,
        approxTotalOps: APPROX_TOTAL_OPS["zexdoc.com"]!,
      });
      // Always log captured output so a failure surfaces what zexdoc said.
      console.log("zexdoc output:\n" + r.output);
      // zexdoc prints "ERROR" on the first failed test and "ok" otherwise.
      // Successful run ends with "Tests complete" or similar.
      expect(r.output).not.toMatch(/ERROR/);
      expect(r.output).toMatch(/complete/i);
    },
  );
});

describe.skipIf(SKIP)("zexall", () => {
  it("all-behaviour CRCs match", { timeout: ZEX_TIMEOUT }, async () => {
    const bin = await loadZEXBinary("zexall.com");
    if (!bin) {
      console.warn(
        "zexall.com not available; drop into fixtures or set " +
          "ZEX_URL_ZEXALL_COM",
      );
      return;
    }
    const h = makeProgramHarness();
    const r = runCpm(h, bin, {
      maxOps: MAX_OPS,
      progressEvery: SHOW_PROGRESS_EVERY_OPS,
      approxTotalOps: APPROX_TOTAL_OPS["zexall.com"]!,
    });
    console.log("zexall output:\n" + r.output);
    expect(r.output).not.toMatch(/ERROR/);
    expect(r.output).toMatch(/complete/i);
  });
});
