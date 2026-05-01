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

describe("μPD8255 port C pass-through", () => {
  it("main writes port C → sub reads port C", () => {
    const { main, sub } = setup();
    main.write(0xfe, 0x5a);
    expect(sub.read(0xfe)).toBe(0x5a);
  });

  it("sub writes port C → main reads port C", () => {
    const { main, sub } = setup();
    sub.write(0xfe, 0xa5);
    expect(main.read(0xfe)).toBe(0xa5);
  });

  it("main and sub C channels are independent", () => {
    const { main, sub } = setup();
    main.write(0xfe, 0x11);
    sub.write(0xfe, 0x22);
    expect(sub.read(0xfe)).toBe(0x11);
    expect(main.read(0xfe)).toBe(0x22);
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

  it("bit set/reset (bit 7 = 0) sets a port C bit on the writer's outgoing C", () => {
    const { main, sub } = setup();
    main.write(0xff, 0x07);
    expect(sub.read(0xfe) & 0x08).toBe(0x08);
  });

  it("bit set/reset can clear a previously-set bit", () => {
    const { main, sub } = setup();
    main.write(0xff, 0x07);
    main.write(0xff, 0x06);
    expect(sub.read(0xfe) & 0x08).toBe(0);
  });

  it("bit set/reset on sub side modifies sub's outgoing C only", () => {
    const { main, sub } = setup();
    sub.write(0xff, 0x09);
    expect(main.read(0xfe) & 0x10).toBe(0x10);
    expect(sub.read(0xfe) & 0x10).toBe(0);
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
