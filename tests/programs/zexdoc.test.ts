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

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeProgramHarness, runCpm } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const DEFAULT_URLS: Record<string, string> = {
  "zexdoc.com":
    "https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexdoc.com",
  "zexall.com":
    "https://raw.githubusercontent.com/anotherlin/z80emu/master/testfiles/zexall.com",
};

async function loadBinary(name: string): Promise<Uint8Array | null> {
  const cached = join(FIXTURES, name);
  if (existsSync(cached)) {
    return new Uint8Array(await readFile(cached));
  }
  const url = process.env[`ZEX_URL_${name.replace(".", "_").toUpperCase()}`] ??
    DEFAULT_URLS[name];
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    await mkdir(FIXTURES, { recursive: true });
    await writeFile(cached, buf);
    return buf;
  } catch {
    return null;
  }
}

const SKIP = process.env.ZEX !== "1";

describe.skipIf(SKIP)("zexdoc", () => {
  it(
    "all documented-behaviour CRCs match",
    { timeout: 15 * 60_000 },
    async () => {
      const bin = await loadBinary("zexdoc.com");
      if (!bin) {
        console.warn(
          "zexdoc.com not available; drop the binary into " +
            "tests/programs/fixtures/zexdoc.com or set ZEX_URL_ZEXDOC_COM",
        );
        return;
      }
      const h = makeProgramHarness();
      const r = runCpm(h, bin, {
        maxOps: 20_000_000_000,
        progressEvery: 50_000_000,
        approxTotalOps: 8_500_000_000,
      });
      // Always log captured output so a failure surfaces what zexdoc said.
      // eslint-disable-next-line no-console
      console.log("zexdoc output:\n" + r.output);
      // zexdoc prints "ERROR" on the first failed test and "ok" otherwise.
      // Successful run ends with "Tests complete" or similar.
      expect(r.output).not.toMatch(/ERROR/);
      expect(r.output).toMatch(/complete/i);
    },
  );
});

describe.skipIf(SKIP)("zexall", () => {
  it(
    "all-behaviour CRCs match",
    { timeout: 15 * 60_000 },
    async () => {
      const bin = await loadBinary("zexall.com");
      if (!bin) {
        console.warn(
          "zexall.com not available; drop into fixtures or set " +
            "ZEX_URL_ZEXALL_COM",
        );
        return;
      }
      const h = makeProgramHarness();
      const r = runCpm(h, bin, {
        maxOps: 20_000_000_000,
        progressEvery: 50_000_000,
        approxTotalOps: 9_000_000_000,
      });
      // eslint-disable-next-line no-console
      console.log("zexall output:\n" + r.output);
      expect(r.output).not.toMatch(/ERROR/);
      expect(r.output).toMatch(/complete/i);
    },
  );
});
