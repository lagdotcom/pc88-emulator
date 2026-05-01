import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8, u16 } from "../../flavours.js";

const log = logLib.get("kanji");

// Kanji ROM lookup ports. mkI ships with one bank ("kanji1"), mkII+
// adds a second ("kanji2"). MAME maps:
//
//   0xE8-0xEB    kanji ROM #0 (level 1, JIS X 0208 first plane)
//   0xEC-0xEF    kanji ROM #1 (level 2, JIS X 0208 second plane)
//
// Each 4-port group provides one address-latch + one data-readout
// pair, mirrored: writing port `base+0` sets the low byte of the
// kanji address, port `base+1` sets the high byte (per MAME's
// `kanji_w` template). Reads at the same offsets fetch one byte of
// the 16-byte 16x16-pixel bitmap stored at the latched address. The
// upper two ports (`base+2`, `base+3`) are documented as
// "read start/end sign" per the retrocomputerpeople.web.fc2.com
// reference but their role isn't exercised by first-light boot.
//
// We don't have the kanji ROM image loaded into a chip yet (the
// `mkI-kanji1.rom` slot is optional in `ROMManifest`). Until we
// wire it in, the stub:
//
//   - latches the 16-bit address per bank for diagnostics
//   - returns 0xFF on read (= "no kanji data" / blank glyph) so
//     BIOS code that probes the ROM falls back to its own font
//
// First-light boot writes a few lookup addresses but never reads
// the bitmaps because the BIOS hasn't enabled kanji rendering by
// the banner-print stage.
export interface KanjiSnapshot {
  banks: { addr: u16 }[];
}

export class KanjiROM {
  private readonly addrs: u16[] = [0, 0];

  snapshot(): KanjiSnapshot {
    return { banks: this.addrs.map((addr) => ({ addr })) };
  }

  fromSnapshot(s: KanjiSnapshot): void {
    for (let i = 0; i < this.addrs.length; i++) {
      const b = s.banks[i];
      if (b) this.addrs[i] = b.addr;
    }
  }

  // `basePort` is 0xE8 for level 1, 0xEC for level 2. `bank` is the
  // index into our internal address-latch array (matches the level).
  registerBank(bus: IOBus, basePort: u8, bank: number): void {
    if (bank < 0 || bank >= this.addrs.length) {
      log.warn(`registerBank: invalid bank ${bank}`);
      return;
    }
    for (let off = 0; off < 4; off++) {
      const port = (basePort + off) as u8;
      bus.register(port, {
        name: `kanji${bank}/${off}`,
        // Real chip would return one byte of the looked-up bitmap.
        // We don't have the ROM mapped yet — return 0xFF for
        // "blank pixels".
        read: () => 0xff,
        write: (_p, v) => this.handleWrite(bank, off, v),
      });
    }
  }

  private handleWrite(bank: number, regOffset: number, value: u8): void {
    if ((regOffset & 0x02) !== 0) {
      // base+2 / base+3 — "read start/end sign" per MAME's TODO comment.
      // No-op until a boot path actually depends on it.
      return;
    }
    if ((regOffset & 0x01) === 0) {
      this.addrs[bank] = (this.addrs[bank]! & 0xff00) | (value & 0xff);
    } else {
      this.addrs[bank] = (this.addrs[bank]! & 0x00ff) | (value << 8);
    }
  }
}
