import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import type { DipSwitchState } from "../../machines/config.js";
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
// DIP defaults come from `PC88Config.dipSwitches` per machine variant
// — never hardcode a magic byte here. SystemController only knows
// "what to do with port writes", not "what model this is".
//
// Anything outside this set falls through to the IOBus default
// (noisy-once 0xff / no-op).

// Persistent state surfaced via snapshot() — JSON-friendly so
// future savestate code can serialise the chip without touching
// implementation details. Restore via fromSnapshot().
export interface SystemControllerSnapshot {
  dipSwitch1: u8;
  dipSwitch2: u8;
  systemStatus: u8;
}

export class SystemController {
  // Live DIP-switch bytes returned by reads at 0x30 / 0x31. Mutable
  // because the BIOS can OUT to these ports too — that overwrites
  // the "presented" value (real silicon: writes go to a system
  // register that shadows the same port number for read-back).
  dipSwitch1: u8;
  dipSwitch2: u8;

  // System status latch (read at 0x40). Returns "VRAM not in use,
  // sub-CPU not busy" idle state. Bit 5 toggles VBL state per the
  // CRTC pump.
  systemStatus: u8 = 0xff;

  // Visible to the runner so the VBL pulse can flip the bit too.
  setVBlank(active: boolean): void {
    if (active) this.systemStatus |= 0x20;
    else this.systemStatus &= ~0x20;
  }

  snapshot(): SystemControllerSnapshot {
    return {
      dipSwitch1: this.dipSwitch1,
      dipSwitch2: this.dipSwitch2,
      systemStatus: this.systemStatus,
    };
  }

  fromSnapshot(s: SystemControllerSnapshot): void {
    this.dipSwitch1 = s.dipSwitch1;
    this.dipSwitch2 = s.dipSwitch2;
    this.systemStatus = s.systemStatus;
  }

  constructor(
    private readonly memoryMap: PC88MemoryMap,
    private readonly beeper: Beeper,
    dips: DipSwitchState,
  ) {
    this.dipSwitch1 = dips.port30;
    this.dipSwitch2 = dips.port31;
  }

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
      write: (_p, v) => log.info(`0x71 write ${v.toString(16)}`),
    });
  }

  private handle30(v: u8): void {
    const cols = v & 0x01 ? 80 : 40;
    const color = v & 0x02 ? "mono" : "color";
    const carrier = v & 0x04 ? "mark" : "space";
    const motor = (v & 0x08) !== 0;
    const usart = (
      {
        0: "cmt600",
        0x10: "cmt1200",
        0x20: "rs232c",
        0x30: "rs232c",
      } as const
    )[v & 0x30];

    log.info(
      `0x30 write: cols=${cols} color=${color} carrier=${carrier} motor=${motor} usart=${usart}`,
    );
  }

  private handle31(v: u8): void {
    const lines = v & 0x01 ? 200 : 400;
    const mmode = v & 0x02 ? "ram" : "rom";
    const rmode = v & 0x04 ? "n80" : "n88";
    const graph = v & 0x08 ? "graphics" : "none";
    const hcolor = v & 0x10 ? "color" : "mono";
    const highres = (v & 0x20) !== 0;

    log.info(
      `0x31 write: lines=${lines} mmode=${mmode} rmode=${rmode} graph=${graph} hcolor=${hcolor} highres=${highres}`,
    );

    // Earlier code propagated `mmode` to setBasicRomEnabled() and
    // `rmode` to setBasicMode() on every port-0x31 write, on the
    // theory that the BIOS would use those bits to flip BASIC modes
    // at runtime. That was wrong — port 0x31 writes have *different*
    // bit semantics from reads (reads return DIP state; writes are a
    // multi-purpose system register where bit 1 is meaningful only
    // in conjunction with other bits we don't model yet). Doing the
    // propagation tripped the BIOS into "ROM mapped out" mid-init
    // and stuck it before CRTC programming. Cold-boot DIP selection
    // is handled in PC88Machine.reset() instead. Until we model the
    // full system-register semantics, treat port 0x31 writes as
    // configuration-only.
  }

  private handle32(v: u8): void {
    const eromsl = v & 0x03;
    const avc = (
      {
        0x00: "tv-video",
        0x04: "PROHIBITED",
        0x08: "computer",
        0x0c: "option",
      } as const
    )[v & 0x0c];
    const tmode = v & 0x10 ? "main" : "high-speed";
    const pmode = v & 0x20 ? "analog-512" : "digital-8";
    const gvam = v & 0x40 ? "extended" : "independent";
    const sintm = v & 0x80 ? "disable" : "enable";

    log.info(
      `0x32 write: eromsl=${eromsl} avc=${avc} tmode=${tmode} pmode=${pmode} gvam=${gvam} sintm=${sintm}`,
    );

    // bits 0-1 select which extension-ROM slot is "current"; the
    // mapping is only applied when E-ROMs are also enabled. The
    // historical mkI N-BASIC behaviour we matched empirically was
    // "eromsl == 0 maps E0 in, anything else falls back to BASIC
    // continuation" — so we mirror that as: select the slot, and
    // enable iff eromsl == 0. TODO: this is almost certainly wrong
    // for N88-BASIC which uses E1/E2/E3; the real enable bit is
    // probably elsewhere on this port (or another) and we'll only
    // know when the N88 trace surfaces it.
    this.memoryMap.setEromSlot((eromsl & 0x03) as 0 | 1 | 2 | 3);
    this.memoryMap.setEromEnabled(eromsl === 0);
  }

  private handle40(v: u8): void {
    const pstb = !(v & 0x01);
    const cstb = (v & 0x02) !== 0;
    const cck = (v & 0x04) !== 0;
    const clds = !(v & 0x08);
    const ghsm = (v & 0x10) !== 0;
    const beep = (v & 0x20) !== 0;
    const jop1 = (v & 0x40) !== 0;
    const fbeep = (v & 0x80) !== 0;

    log.info(
      `0x40 write: pstb=${pstb} cstb=${cstb} cck=${cck} clds=${clds} ghsm=${ghsm} beep=${beep} jop1=${jop1} fbeep=${fbeep}`,
    );

    this.beeper.toggle(beep);
  }
}
