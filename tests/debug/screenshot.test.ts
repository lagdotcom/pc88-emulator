import { describe, expect, it } from "vitest";

import {
  dispatch,
  type DispatchCtx,
  makeDebugState,
  setDebugWriter,
} from "../../src/debug/debug.js";
import type { u8 } from "../../src/flavours.js";
import { PC88Machine } from "../../src/machines/pc88.js";
import type { LoadedROMs } from "../../src/machines/pc88-memory.js";
import { MKI } from "../../src/machines/variants/mk1.js";
import { filledROM } from "../tools.js";

function syntheticRoms(program: u8[]): LoadedROMs {
  const n80 = filledROM(0x8000, 0x76);
  for (let i = 0; i < program.length; i++) n80[i] = program[i]!;
  const n88 = filledROM(0x8000, 0x76);
  const e0 = filledROM(0x2000, 0x76);
  return { n80, n88, e0 };
}

function buildCtx(opts: {
  saveScreenshot?: (frame: { width: number; height: number }, path: string) => void;
} = {}): DispatchCtx & { writes: string[] } {
  const machine = new PC88Machine(MKI, syntheticRoms([0x76]));
  machine.reset();
  // Make GVRAM visible so getPixelFrame returns a non-trivial frame.
  machine.displayRegs.showGVRAM0 = true;
  const writes: string[] = [];
  setDebugWriter((s) => {
    writes.push(s);
  });
  const state = makeDebugState();
  return {
    machine,
    state,
    syms: null,
    opts: opts.saveScreenshot ? { saveScreenshot: opts.saveScreenshot } : {},
    writes,
  };
}

describe("debug `screenshot` command", () => {
  it("invokes opts.saveScreenshot with the current frame and the requested path", async () => {
    const calls: { width: number; height: number; path: string }[] = [];
    const ctx = buildCtx({
      saveScreenshot: (frame, path) => {
        calls.push({ width: frame.width, height: frame.height, path });
      },
    });
    const result = await dispatch("screenshot /tmp/x.png", ctx);
    expect(result).toEqual({ quit: false });
    expect(calls).toEqual([{ width: 640, height: 200, path: "/tmp/x.png" }]);
    expect(ctx.writes.join("")).toContain("wrote 640×200 screenshot to /tmp/x.png");
  });

  it("`ss` is a short alias for `screenshot`", async () => {
    let invoked = false;
    const ctx = buildCtx({
      saveScreenshot: () => {
        invoked = true;
      },
    });
    await dispatch("ss /tmp/y.png", ctx);
    expect(invoked).toBe(true);
  });

  it("accepts paths containing spaces (joins remaining args)", async () => {
    let receivedPath = "";
    const ctx = buildCtx({
      saveScreenshot: (_f, path) => {
        receivedPath = path;
      },
    });
    await dispatch("screenshot /tmp/path with spaces.png", ctx);
    expect(receivedPath).toBe("/tmp/path with spaces.png");
  });

  it("prints usage when called with no PATH", async () => {
    const ctx = buildCtx({ saveScreenshot: () => {} });
    await dispatch("screenshot", ctx);
    expect(ctx.writes.join("")).toContain("usage: screenshot PATH");
  });

  it("prints a diagnostic when no saver is wired (web case)", async () => {
    const ctx = buildCtx(); // no saveScreenshot
    await dispatch("screenshot /tmp/z.png", ctx);
    expect(ctx.writes.join("")).toContain("no saver wired");
  });

  it("reports a friendly error if the saver throws", async () => {
    const ctx = buildCtx({
      saveScreenshot: () => {
        throw new Error("disk full");
      },
    });
    await dispatch("screenshot /tmp/oops.png", ctx);
    expect(ctx.writes.join("")).toContain("screenshot failed: disk full");
  });
});
