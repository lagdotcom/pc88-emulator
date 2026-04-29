import logLib from "log";

import type { u8 } from "../../flavours.js";
import type { IOBus } from "../../core/IOBus.js";

const log = logLib.get("dmac");

// μPD8257 DMAC stub. The PC-88 uses one channel (typically channel 2)
// to drive the CRTC's character-pull DMA from text VRAM. For
// first-light we accept the address/count writes and the mode latch,
// but do not actually schedule transfers — TVRAM is read directly by
// the display capture, not via DMA.
//
// Each channel takes a low-byte / high-byte alternating pair of writes
// for the address (port 2*ch + 0) and count (port 2*ch + 1). Mode is
// at 0x68. We track the byte-pair flip-flop because real BIOS resets
// it between writes; without that, the second byte is misread.
export class Dmac8257 {
  private addressLow: number[] = [0, 0, 0, 0];
  private addressHigh: number[] = [0, 0, 0, 0];
  private countLow: number[] = [0, 0, 0, 0];
  private countHigh: number[] = [0, 0, 0, 0];
  private toggle = false;
  private mode = 0;
  status: u8 = 0;

  register(bus: IOBus): void {
    for (let ch = 0; ch < 4; ch++) {
      const addrPort = 0x60 + ch * 2;
      const countPort = 0x60 + ch * 2 + 1;
      bus.register(addrPort, {
        name: `dmac/addr${ch}`,
        write: (_p, v) => this.writeAddress(ch, v),
      });
      bus.register(countPort, {
        name: `dmac/count${ch}`,
        write: (_p, v) => this.writeCount(ch, v),
      });
    }
    bus.register(0x68, {
      name: "dmac/mode",
      read: () => this.status,
      write: (_p, v) => this.writeMode(v),
    });
  }

  private writeAddress(ch: number, v: u8): void {
    if (!this.toggle) this.addressLow[ch] = v;
    else this.addressHigh[ch] = v;
    this.toggle = !this.toggle;
  }

  private writeCount(ch: number, v: u8): void {
    if (!this.toggle) this.countLow[ch] = v;
    else this.countHigh[ch] = v;
    this.toggle = !this.toggle;
  }

  private writeMode(v: u8): void {
    this.mode = v;
    this.toggle = false;
    log.debug(`mode 0x${v.toString(16)}`);
  }
}
