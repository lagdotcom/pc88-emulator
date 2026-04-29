import { describe, expect, it } from "vitest";

import { μPD3301 } from "../../../src/chips/io/μPD3301.js";
import { IOBus } from "../../../src/core/IOBus.js";

function setup() {
  const bus = new IOBus();
  const crtc = new μPD3301();
  crtc.register(bus);
  return { bus, crtc };
}

describe("μPD3301 port routing", () => {
  it("dispatches commands written to port 0x51", () => {
    const { bus, crtc } = setup();
    // RESET / SET MODE: cmd 0x00 expects 5 params.
    bus.write(0x51, 0x00);
    bus.write(0x50, 0xce); // chars-per-row byte length: 80
    bus.write(0x50, 0x93); // rows-1: 0x13 → 20
    bus.write(0x50, 0x69); // attr-pairs / per-row config
    bus.write(0x50, 0xbe); // char height-1
    bus.write(0x50, 0x13); // cursor / blink config
    expect(crtc.charsPerRow).toBe(80);
    expect(crtc.rowsPerScreen).toBe(20);
    expect(crtc.attrPairsPerRow).toBe(9);
  });

  it("ignores writes to 0x50 when no command is in flight", () => {
    const { bus, crtc } = setup();
    // Without a preceding command, parameter writes are stray data.
    bus.write(0x50, 0xab);
    bus.write(0x50, 0xcd);
    expect(crtc.charsPerRow).toBe(0);
    expect(crtc.rowsPerScreen).toBe(0);
  });

  it("port 0x50 read returns the live status byte", () => {
    const { bus, crtc } = setup();
    crtc.setVBlank(true);
    expect(bus.read(0x50)).toBe(crtc.status);
    expect(bus.read(0x51)).toBe(crtc.status);
  });
});

describe("μPD3301 command decoding", () => {
  it("decodes by top-3-bits, not by exact byte", () => {
    // 0x43 (top bits 010) is SET INTERRUPT MASK with 0 params, so
    // sending it doesn't leave the parser waiting for 5 parameter
    // bytes. A SET MODE block can immediately follow.
    const { bus, crtc } = setup();
    bus.write(0x51, 0x43); // SET INTERRUPT MASK
    bus.write(0x51, 0x00); // SET MODE
    bus.write(0x50, 0xce);
    bus.write(0x50, 0x93);
    bus.write(0x50, 0x69);
    bus.write(0x50, 0xbe);
    bus.write(0x50, 0x13);
    expect(crtc.charsPerRow).toBe(80);
    expect(crtc.rowsPerScreen).toBe(20);
  });

  it("START DISPLAY (0x20) flips displayOn and consumes no params", () => {
    const { bus, crtc } = setup();
    bus.write(0x51, 0x20);
    expect(crtc.displayOn).toBe(true);
    // The next write to the DATA port should be a stray, not eaten
    // as a parameter by the START DISPLAY handler.
    bus.write(0x50, 0xff);
    expect(crtc.charsPerRow).toBe(0);
  });

  it("RESET (0x00 family) clears parsed mode and displayOn", () => {
    const { bus, crtc } = setup();
    // Program a mode and turn the display on.
    bus.write(0x51, 0x00);
    bus.write(0x50, 0xce);
    bus.write(0x50, 0x93);
    bus.write(0x50, 0x69);
    bus.write(0x50, 0xbe);
    bus.write(0x50, 0x13);
    bus.write(0x51, 0x20);
    expect(crtc.displayOn).toBe(true);

    // Send a fresh RESET command; the *command write itself* drops
    // displayOn and zeroes the mode (the actual SET MODE happens
    // when the 5 follow-up params arrive).
    bus.write(0x51, 0x00);
    expect(crtc.displayOn).toBe(false);
    expect(crtc.charsPerRow).toBe(0);
    expect(crtc.rowsPerScreen).toBe(0);
  });

  it("LOAD CURSOR (0x80 family) consumes 2 params, not 5", () => {
    // Earlier code had 0x80-0x9F as SET MODE with 5 params; the
    // actual LOAD CURSOR family takes 2. Verify the fix sticks.
    const { bus, crtc } = setup();
    bus.write(0x51, 0x81); // LOAD CURSOR variant
    bus.write(0x50, 0x10); // x
    bus.write(0x50, 0x05); // y
    // After 2 params the parser should be idle again — the next
    // data-port write is a stray and shouldn't update mode state.
    bus.write(0x50, 0xff);
    expect(crtc.charsPerRow).toBe(0);
  });
});
