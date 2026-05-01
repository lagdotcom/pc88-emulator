import type { IOBus } from "../../core/IOBus.js";
import type { u8, u16 } from "../../flavours.js";
import { getLogger } from "../../log.js";
import { byte, word } from "../../tools.js";

const log = getLogger("dmac");

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
export interface DmacSnapshot {
  addressLow: u8[]; // length 4
  addressHigh: u8[];
  countLow: u8[];
  countHigh: u8[];
  toggle: boolean;
  mode: u8;
  status: u8;
}

export class μPD8257 {
  private addressLow: u8[] = [0, 0, 0, 0];
  private addressHigh: u8[] = [0, 0, 0, 0];
  private countLow: u8[] = [0, 0, 0, 0];
  private countHigh: u8[] = [0, 0, 0, 0];
  private toggle = false;
  private mode = 0;
  status: u8 = 0;

  // Composite views per channel. The PC-88 uses channel 2 to feed
  // TVRAM bytes to the μPD3301 every frame; the source address +
  // length pair tells the display which TVRAM region is "what would
  // appear on screen". The low 14 bits of the count are the byte
  // count - 1 per the 8257 datasheet; we mask + add 1.
  channelAddress(ch: number): u16 {
    return ((this.addressHigh[ch]! << 8) | this.addressLow[ch]!) & 0xffff;
  }
  channelByteCount(ch: number): u16 {
    const raw = ((this.countHigh[ch]! << 8) | this.countLow[ch]!) & 0x3fff;
    return raw + 1;
  }

  snapshot(): DmacSnapshot {
    return {
      addressLow: this.addressLow.slice(),
      addressHigh: this.addressHigh.slice(),
      countLow: this.countLow.slice(),
      countHigh: this.countHigh.slice(),
      toggle: this.toggle,
      mode: this.mode,
      status: this.status,
    };
  }

  fromSnapshot(s: DmacSnapshot): void {
    this.addressLow = s.addressLow.slice();
    this.addressHigh = s.addressHigh.slice();
    this.countLow = s.countLow.slice();
    this.countHigh = s.countHigh.slice();
    this.toggle = s.toggle;
    this.mode = s.mode;
    this.status = s.status;
  }

  register(bus: IOBus): void {
    for (let ch = 0; ch < 4; ch++) {
      const addrPort = 0x60 + ch * 2;
      const countPort = 0x60 + ch * 2 + 1;
      bus.register(addrPort, {
        name: `dmac/addr${ch}`,
        read: () => {
          log.info(`0x${byte(addrPort)} read`);
          return 0xff;
        },
        write: (_p, v) => this.writeAddress(ch, v),
      });
      bus.register(countPort, {
        name: `dmac/count${ch}`,
        read: () => {
          log.info(`0x${byte(countPort)} read`);
          return 0xff;
        },
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

    if (!this.toggle)
      log.info(`ch${ch}.address=${word(this.channelAddress(ch))}`);
  }

  private writeCount(ch: number, v: u8): void {
    if (!this.toggle) this.countLow[ch] = v;
    else this.countHigh[ch] = v;
    this.toggle = !this.toggle;

    if (!this.toggle)
      log.info(`ch${ch}.count=${word(this.channelByteCount(ch))}`);
  }

  // Mode-set register bit layout per the i8257 / μPD8257 datasheet:
  //
  //   bit 0  EN0  enable channel 0
  //   bit 1  EN1  enable channel 1
  //   bit 2  EN2  enable channel 2
  //   bit 3  EN3  enable channel 3
  //   bit 4  ROT  rotating-priority mode
  //   bit 5  EXT  extended write
  //   bit 6  TCS  TC-stop (auto-disable channel on terminal count)
  //   bit 7  AL   auto-load (chain to channel 2/3 on TC for ch 2)
  //
  // PC-88 BIOS programs this register with two values during init:
  //   0x80 = AL alone — no channels enabled; configures the
  //          autoload register.
  //   0xC4 = AL | TCS | EN2 — enables channel 2 (CRTC raster
  //          streaming) with autoload + TC-stop. This is the
  //          steady-state value the runner observes most of the
  //          time once the screen is running.
  //
  // We don't act on the mode register yet — channel 2 is "always
  // on" from the renderer's perspective. Logged as a stub so the
  // BIOS's mode programming stays visible.
  private writeMode(v: u8): void {
    this.mode = v;
    this.toggle = false;
    log.warn(`mode 0x${v.toString(16)} (stub — bits not acted on)`);
  }
}
