// SingleStepTests/z80 harness. Test data is fetched on demand from
// https://github.com/SingleStepTests/z80 and cached under tests/z80/data
// (gitignored). Env vars:
//   Z80_OP=00          run only this filename (e.g. "00", "ed 40")
//   Z80_PREFIX=ed      run only this prefix (base|cb|dd|ed|fd)
//   Z80_SAMPLE=N|full  cases per opcode (default 25, "full" = all 1000)
//   Z80_IGNORE_REGS=r,ei  comma list of register keys to skip
import { describe, expect, it } from "vitest";

import {
  cbOpCodes,
  ddCbOpCodes,
  ddOpCodes,
  edOpCodes,
  fdCbOpCodes,
  fdOpCodes,
  opCodes,
} from "../../src/chips/z80/ops.js";
import { byte } from "../../src/tools.js";
import { loadTests } from "./fetch.js";
import {
  diffState,
  loadState,
  makeHarness,
  seedPorts,
  step,
} from "./harness.js";
import type { TestCase } from "./types.js";

const PREFIX_BYTES = new Set([0xcb, 0xdd, 0xed, 0xfd]);

interface OpGroup {
  prefix: string;
  filename: string;
  description: string;
}

// Opcodes that only set up another prefix don't have their own SingleStepTests
// JSON file (e.g. DD followed by DD just resets the prefix). Detect them by
// the "PREFIX" mnemonic the table generator emits.
function isPrefixOp(mnemonic: string): boolean {
  return mnemonic.startsWith("PREFIX");
}

function gatherOps(): OpGroup[] {
  const groups: OpGroup[] = [];

  for (const code of Object.keys(opCodes).map(Number)) {
    if (PREFIX_BYTES.has(code)) continue;
    if (isPrefixOp(opCodes[code]!.mnemonic)) continue;
    groups.push({
      prefix: "base",
      filename: byte(code),
      description: `${byte(code)} ${opCodes[code]!.mnemonic}`,
    });
  }

  for (const [prefix, table] of [
    ["ed", edOpCodes],
    ["cb", cbOpCodes],
    ["dd", ddOpCodes],
    ["fd", fdOpCodes],
  ] as const) {
    for (const code of Object.keys(table).map(Number)) {
      if (isPrefixOp(table[code]!.mnemonic)) continue;
      groups.push({
        prefix,
        filename: `${prefix} ${byte(code)}`,
        description: `${prefix.toUpperCase()} ${byte(code)} ${table[code]!.mnemonic}`,
      });
    }
  }

  // DDCB / FDCB share the same filename convention "<prefix> cb __ XX.json"
  // where __ is the displacement placeholder (varies per case in the file).
  for (const [prefix, table] of [
    ["dd", ddCbOpCodes],
    ["fd", fdCbOpCodes],
  ] as const) {
    for (const code of Object.keys(table).map(Number)) {
      groups.push({
        prefix: `${prefix}cb`,
        filename: `${prefix} cb __ ${byte(code)}`,
        description: `${prefix.toUpperCase()} CB __ ${byte(code)} ${table[code]!.mnemonic}`,
      });
    }
  }

  return groups;
}

const sampleEnv = process.env.Z80_SAMPLE;
const SAMPLE =
  sampleEnv === "full"
    ? Infinity
    : sampleEnv
      ? Number.parseInt(sampleEnv, 10)
      : 25;

const opFilter = process.env.Z80_OP;
const prefixFilter = process.env.Z80_PREFIX;

const skipRegs = new Set<string>(
  (process.env.Z80_IGNORE_REGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const groups = gatherOps().filter((g) => {
  if (opFilter && g.filename !== opFilter) return false;
  if (prefixFilter && g.prefix !== prefixFilter) return false;
  return true;
});

// Eagerly load tests so describe.each can build per-case sub-tests.
const loaded: { group: OpGroup; cases: TestCase[] | Error }[] = [];
for (const group of groups) {
  try {
    const cases = await loadTests(group.filename);
    loaded.push({
      group,
      cases: SAMPLE === Infinity ? cases : cases.slice(0, SAMPLE),
    });
  } catch (err) {
    loaded.push({ group, cases: err as Error });
  }
}

function diffMessage(
  diffs: ReturnType<typeof diffState>,
  expected: TestCase["final"],
): string {
  return diffs
    .map((d) => {
      if (d.reg) {
        const get = (k: string) =>
          (expected as unknown as Record<string, number>)[k];
        // For F, also surface the bit-level diff.
        if (d.reg === "f") {
          const xor = d.got ^ d.want;
          const bits = ["c", "n", "pv", "x", "h", "y", "z", "s"]
            .map((b, i) => (xor & (1 << i) ? b : null))
            .filter(Boolean)
            .join(",");
          return `f: got ${byte(d.got)} want ${byte(d.want)} (diff bits: ${bits})`;
        }
        const w = get(d.reg) ?? 0;
        const wid = d.want > 0xff || w > 0xff ? 4 : 2;
        return `${d.reg}: got ${d.got.toString(16).padStart(wid, "0")} want ${d.want.toString(16).padStart(wid, "0")}`;
      }
      return `ram[${d.ramAddr!.toString(16).padStart(4, "0")}]: got ${byte(d.got)} want ${byte(d.want)}`;
    })
    .join("; ");
}

for (const { group, cases } of loaded) {
  describe(group.description, () => {
    if (cases instanceof Error) {
      it("failed to load test data", () => {
        throw cases;
      });
      return;
    }
    if (cases.length === 0) {
      it.skip("no cases", () => {});
      return;
    }

    it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, tc) => {
      const h = makeHarness();
      loadState(h, tc.initial);
      seedPorts(h, tc);
      step(h);
      const diffs = diffState(h, tc.final, { skipRegs });
      if (diffs.length) expect.fail(diffMessage(diffs, tc.final));
    });
  });
}
