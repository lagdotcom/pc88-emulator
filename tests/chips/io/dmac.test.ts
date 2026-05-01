import { describe, expect, it } from "vitest";

import { μPD8257 } from "../../../src/chips/io/μPD8257.js";
import { IOBus } from "../../../src/core/IOBus.js";

function setup() {
  const bus = new IOBus();
  const dmac = new μPD8257();
  dmac.register(bus);
  return { bus, dmac };
}

describe("μPD8257 channel address / count", () => {
  it("assembles 16-bit address from low/high byte writes", () => {
    const { bus, dmac } = setup();
    // Channel 2 address port = 0x60 + 2*2 = 0x64. The 8257 alternates
    // low byte then high byte on each write (the BIOS resets the
    // toggle by writing the mode register at 0x68).
    bus.write(0x64, 0x00); // address low
    bus.write(0x64, 0xf3); // address high
    expect(dmac.channelAddress(2)).toBe(0xf300);
  });

  it("assembles count and adds 1 (per the 8257 datasheet)", () => {
    const { bus, dmac } = setup();
    // Channel 2 count port = 0x65. BASIC programs 0x0960 - 1 here
    // to fetch 2400 bytes (= 20 rows × 120 bytes per row).
    bus.write(0x65, 0x5f); // count low (0x5F = 0x960 - 1 lo)
    bus.write(0x65, 0x09); // count high
    expect(dmac.channelByteCount(2)).toBe(0x0960);
  });

  it("masks the high two bits of the count register", () => {
    // The high two bits of the count register are channel-mode bits
    // (read/write/verify), not part of the 14-bit byte count. The
    // user-facing byte count must mask them off.
    const { bus, dmac } = setup();
    bus.write(0x65, 0xff); // low
    bus.write(0x65, 0xff); // high — mode bits set, count bits all 1
    // Low 14 bits of 0xFFFF = 0x3FFF; +1 → 0x4000.
    expect(dmac.channelByteCount(2)).toBe(0x4000);
  });

  it("writeMode resets the byte-pair toggle", () => {
    const { bus, dmac } = setup();
    // Start an address sequence then interrupt with a mode write —
    // the next address byte should land in the LOW slot, not the
    // HIGH slot. (BIOS does this between channel programmings.)
    bus.write(0x64, 0x12); // ch2 addr low
    bus.write(0x68, 0xc4); // mode register write
    bus.write(0x64, 0x34); // intended as a fresh "low" again
    bus.write(0x64, 0x56); // and now the high
    expect(dmac.channelAddress(2)).toBe(0x5634);
  });

  it("channels are independent", () => {
    const { bus, dmac } = setup();
    bus.write(0x60, 0xaa); // ch0 addr low
    bus.write(0x60, 0xbb); // ch0 addr high
    bus.write(0x64, 0xcc); // ch2 addr low
    bus.write(0x64, 0xdd); // ch2 addr high
    expect(dmac.channelAddress(0)).toBe(0xbbaa);
    expect(dmac.channelAddress(2)).toBe(0xddcc);
  });
});
