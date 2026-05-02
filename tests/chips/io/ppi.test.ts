import { describe, expect, it } from "vitest";

import { μPD8255 } from "../../../src/chips/io/μPD8255.js";
import { IOBus } from "../../../src/core/IOBus.js";

function setup() {
  const main = new IOBus();
  const sub = new IOBus();
  const ppi = new μPD8255();
  ppi.registerMain(main);
  ppi.registerSub(sub);
  return { main, sub, ppi };
}

describe("μPD8255 main → sub channel", () => {
  it("main writes port A (0xFC) → sub reads port B (0xFD)", () => {
    const { main, sub } = setup();
    main.write(0xfc, 0x42);
    expect(sub.read(0xfd)).toBe(0x42);
  });

  it("subHasFresh raised on main write, cleared on sub read of B", () => {
    const { main, sub, ppi } = setup();
    main.write(0xfc, 0x42);
    expect(ppi.hasFreshForSub()).toBe(true);
    sub.read(0xfd);
    expect(ppi.hasFreshForSub()).toBe(false);
  });

  it("sub reading port A returns whatever is on its incoming PA latch", () => {
    const { main, sub } = setup();
    main.write(0xfc, 0x42);
    expect(sub.read(0xfc)).toBe(0);
  });
});

describe("μPD8255 sub → main channel", () => {
  it("sub writes port A (0xFC) → main reads port B (0xFD)", () => {
    const { main, sub } = setup();
    sub.write(0xfc, 0x99);
    expect(main.read(0xfd)).toBe(0x99);
  });

  it("mainHasFresh raised on sub write, cleared on main read of B", () => {
    const { main, sub, ppi } = setup();
    sub.write(0xfc, 0x99);
    expect(ppi.hasFreshForMain()).toBe(true);
    main.read(0xfd);
    expect(ppi.hasFreshForMain()).toBe(false);
  });

  it("the two channels do not interfere", () => {
    const { main, sub } = setup();
    main.write(0xfc, 0x11);
    sub.write(0xfc, 0x22);
    expect(sub.read(0xfd)).toBe(0x11);
    expect(main.read(0xfd)).toBe(0x22);
  });
});

describe("μPD8255 port C high-nibble cross-down remap", () => {
  // Real-silicon PC-88 wiring: the high nibble each side writes to
  // port C lands as the low nibble on the OTHER side's port C read.
  // The high nibble of a side's read is its own outgoing latch
  // (echoed back for software that wants to inspect what it wrote).
  // PC-8031's disk-board ROM relies on the cross-down — it polls
  // bit 3 waiting for the BIOS's bit-7 ATN signal.
  it("main writes high nibble → sub reads low nibble (cross-down)", () => {
    const { main, sub } = setup();
    main.write(0xfe, 0xa0); // bit 7 + bit 5 high
    // Sub's read: own high (= 0) | (main's high >> 4) = 0x0a.
    expect(sub.read(0xfe)).toBe(0x0a);
  });

  it("sub writes high nibble → main reads low nibble (cross-down)", () => {
    const { main, sub } = setup();
    sub.write(0xfe, 0x60); // bit 6 + bit 5 high
    expect(main.read(0xfe)).toBe(0x06);
  });

  it("each side's high nibble echoes back on its own read", () => {
    const { main, sub } = setup();
    main.write(0xfe, 0x80);
    sub.write(0xfe, 0x40);
    // Main reads: own high (0x80) | sub's high >> 4 (0x04) = 0x84
    expect(main.read(0xfe)).toBe(0x84);
    // Sub reads: own high (0x40) | main's high >> 4 (0x08) = 0x48
    expect(sub.read(0xfe)).toBe(0x48);
  });
});

describe("μPD8255 control register", () => {
  it("latches a mode word (bit 7 = 1) per side", () => {
    const { main, sub, ppi } = setup();
    main.write(0xff, 0xa0);
    sub.write(0xff, 0x95);
    expect(ppi.snapshot().mainControl).toBe(0xa0);
    expect(ppi.snapshot().subControl).toBe(0x95);
  });

  it("bit set/reset on main writes a high-nibble bit; sub sees it shifted down", () => {
    const { main, sub } = setup();
    // ctrl 0x0F = set bit 7 on main's port-C output.
    main.write(0xff, 0x0f);
    // Sub reads bit 3 (= bit 7 shifted down by 4).
    expect(sub.read(0xfe) & 0x08).toBe(0x08);
  });

  it("bit set/reset can clear a previously-set bit", () => {
    const { main, sub } = setup();
    main.write(0xff, 0x0f); // set bit 7
    main.write(0xff, 0x0e); // clear bit 7
    expect(sub.read(0xfe) & 0x08).toBe(0);
  });

  it("bit set/reset on sub side: main reads the corresponding low bit", () => {
    const { main, sub } = setup();
    // ctrl 0x0d = set bit 6 on sub's port-C output.
    sub.write(0xff, 0x0d);
    // Main reads bit 2 (= bit 6 shifted down).
    expect(main.read(0xfe) & 0x04).toBe(0x04);
    // Sub's own read sees bit 6 echoed back on the high nibble.
    expect(sub.read(0xfe) & 0x40).toBe(0x40);
  });
});

describe("μPD8255 snapshot / restore", () => {
  it("round-trips latches + control words + fresh flags", () => {
    const { main, sub, ppi } = setup();
    main.write(0xfc, 0x11);
    sub.write(0xfc, 0x22);
    main.write(0xfe, 0x33);
    sub.write(0xfe, 0x44);
    main.write(0xff, 0xa0);
    sub.write(0xff, 0x95);
    const snap = ppi.snapshot();

    const fresh = new μPD8255();
    fresh.fromSnapshot(snap);
    expect(fresh.snapshot()).toEqual(snap);
  });

  it("survives JSON round-trip", () => {
    const { main, sub, ppi } = setup();
    main.write(0xfc, 0xaa);
    sub.write(0xfc, 0xbb);
    const snap = JSON.parse(JSON.stringify(ppi.snapshot()));
    const fresh = new μPD8255();
    fresh.fromSnapshot(snap);
    expect(fresh.hasFreshForSub()).toBe(true);
    expect(fresh.hasFreshForMain()).toBe(true);

    const main2 = new IOBus();
    const sub2 = new IOBus();
    fresh.registerMain(main2);
    fresh.registerSub(sub2);
    expect(sub2.read(0xfd)).toBe(0xaa);
    expect(main2.read(0xfd)).toBe(0xbb);
  });
});

describe("μPD8255 BIOS-style round-trip", () => {
  it("models a host command + sub response exchange", () => {
    const { main, sub, ppi } = setup();

    main.write(0xfc, 0xc1);
    expect(ppi.hasFreshForSub()).toBe(true);

    expect(sub.read(0xfd)).toBe(0xc1);
    expect(ppi.hasFreshForSub()).toBe(false);

    sub.write(0xfc, 0x00);
    expect(ppi.hasFreshForMain()).toBe(true);

    expect(main.read(0xfd)).toBe(0x00);
    expect(ppi.hasFreshForMain()).toBe(false);
  });
});

describe("μPD8255 fresh-data wake hooks", () => {
  it("calls onFreshForSub when main writes port A", () => {
    const { main, ppi } = setup();
    let calls = 0;
    ppi.onFreshForSub = () => calls++;
    main.write(0xfc, 0x42);
    expect(calls).toBe(1);
  });

  it("calls onFreshForMain when sub writes port A", () => {
    const { sub, ppi } = setup();
    let calls = 0;
    ppi.onFreshForMain = () => calls++;
    sub.write(0xfc, 0x99);
    expect(calls).toBe(1);
  });

  it("does not fire on port C writes (only port A is the wake source)", () => {
    const { main, sub, ppi } = setup();
    let subCalls = 0;
    let mainCalls = 0;
    ppi.onFreshForSub = () => subCalls++;
    ppi.onFreshForMain = () => mainCalls++;
    main.write(0xfe, 0x55);
    sub.write(0xfe, 0xaa);
    expect(subCalls).toBe(0);
    expect(mainCalls).toBe(0);
  });

  it("hooks remain null by default and writes work without them", () => {
    const { main, sub } = setup();
    expect(() => main.write(0xfc, 0x42)).not.toThrow();
    expect(() => sub.write(0xfc, 0x99)).not.toThrow();
  });
});
