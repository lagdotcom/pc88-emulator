import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import type { PC88MemoryMap } from "../../machines/pc88-memory.js";
import type { Beeper } from "./beeper.js";

const log = logLib.get("sysctrl");

// PC-88 system-control I/O. This stub covers the ports the BASIC ROM
// init path touches: DIP-switch readback, ROM-bank select, screen mode,
// and the rough "system status" surface. Actual register meanings are
// only approximated — enough to make the ROM stop polling.
//
// References used:
//   - https://www.maroon.dk/pc88_io.txt (community port table)
//   - PC-8801 Hardware Manual (NEC) for the bit assignments on 0x30/0x31
//
// Anything outside this set falls through to the IOBus default
// (noisy-once 0xff / no-op).
export class SystemController {
  // DIP-switch byte presented at port 0x30. Bit layout per NEC docs;
  // for first-light we report a vanilla "BASIC mode 5, terminal off,
  // 80×25, 4 MHz" configuration.
  dipSwitch1: u8 = 0b1111_1011;

  // Secondary DIP byte at port 0x31. "8 colour, V1 mode, 200-line, no
  // memory wait" per NEC.
  dipSwitch2: u8 = 0b1110_1101;

  // System status latch (read at 0x40). Returns "VRAM not in use,
  // sub-CPU not busy" idle state. Bit 5 toggles VBL state per the
  // CRTC pump.
  systemStatus: u8 = 0xff;

  // Visible to the runner so the VBL pulse can flip the bit too.
  setVBlank(active: boolean): void {
    if (active) this.systemStatus |= 0x20;
    else this.systemStatus &= ~0x20;
  }

  constructor(
    private readonly memoryMap: PC88MemoryMap,
    private readonly beeper: Beeper,
  ) {}

  register(bus: IOBus): void {
    bus.register(0x30, {
      name: "sysctrl/0x30",
      read: () => this.dipSwitch1,
      write: (_p, v) => this.handle30(v),
    });
    bus.register(0x31, {
      name: "sysctrl/0x31",
      read: () => this.dipSwitch2,
      write: (_p, v) => this.handle31(v),
    });
    bus.register(0x32, {
      name: "sysctrl/0x32",
      read: () => 0xff,
      write: (_p, v) => this.handle32(v),
    });
    bus.register(0x40, {
      name: "sysctrl/0x40",
      read: () => this.systemStatus,
      write: (_p, v) => this.handle40(v),
    });
    bus.register(0x5c, {
      name: "sysctrl/0x5c",
      write: (_p, v) => this.memoryMap.setGvramPlane((v & 0x03) as 0 | 1 | 2),
    });
    // 0x71 is the secondary ROM bank select on later models. mkI
    // ignores it; we capture it for diagnostics.
    bus.register(0x71, {
      name: "sysctrl/0x71",
      read: () => 0xff,
      write: (_p, v) => log.debug(`0x71 write ${v.toString(16)}`),
    });
  }

  // Port 0x30 write: bit 0 picks N-BASIC vs N88-BASIC, bit 1
  // disables the BASIC ROM area, bit 4 toggles the colour/mono mode
  // (we ignore that for now).
  private handle30(v: u8): void {
    const wantN88 = (v & 0x01) !== 0;
    const romDisabled = (v & 0x02) !== 0;
    this.memoryMap.setBasicMode(wantN88 ? "n88" : "n80");
    this.memoryMap.setBasicRomEnabled(!romDisabled);
  }

  // Port 0x31 write: bit 5 selects between V1 (200-line) and V2
  // (400-line) modes; bit 4 swaps in extended ROMs at 0x6000-0x7FFF.
  private handle31(v: u8): void {
    const e0 = (v & 0x10) !== 0;
    this.memoryMap.setE0RomEnabled(e0);
    this.dipSwitch2 = v;
  }

  // Port 0x32 write: bits gate the VRAM/text-VRAM windows at 0xC000+
  // and 0xF000+. Real silicon has a few more bits we ignore.
  private handle32(v: u8): void {
    const tvram = (v & 0x10) !== 0;
    const gvram = (v & 0x20) !== 0;
    this.memoryMap.setTvramEnabled(tvram);
    this.memoryMap.setVramEnabled(gvram);
  }

  // Port 0x40 write: cassette/strobe/beep/palette latch. Bit 3 is the
  // beeper toggle; everything else is dropped for first-light.
  private handle40(v: u8): void {
    this.beeper.toggle((v & 0x08) !== 0);
  }
}
