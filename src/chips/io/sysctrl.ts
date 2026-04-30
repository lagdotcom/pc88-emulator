import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import type { DIPSwitchState } from "../../machines/config.js";
import type { PC88MemoryMap } from "../../machines/pc88-memory.js";
import { byte } from "../../tools.js";
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
  eromSelection: u8;
  textWindow: u8;
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

  // Expansion ROM selection; set one bit off to select that EROM
  eromSelection: u8 = 0xff;

  // Latched port 0x31 bits we care about for EROM gating. Port 0x31
  // writes don't propagate to BASIC-ROM swapping (see handle31), but
  // bit 1 (MMODE: 0=ROM, 1=RAM at 0x0000-0x7FFF) and bit 2 (RMODE:
  // 0=N88, 1=N80) gate whether EROM is allowed to map at all.
  // Default both 0 to match the reset state where ROM is enabled and
  // N88 is selected; that keeps the EROM mapping logic permissive
  // until the BIOS has actually programmed mmode/rmode.
  private mmode: 0 | 1 = 0;
  private rmode: 0 | 1 = 0;

  // Latched port 0x70 ("Text Window"). High byte of a 1 KB ROM
  // window the BIOS can map into 0x8000-0x83FF when MMODE=0,
  // RMODE=0. Source-ROM details aren't yet confirmed (likely a
  // window into BASIC-ROM continuation past 0x7FFF), so we latch
  // the value for snapshots/diagnostics but don't yet wire the
  // mapping to PC88MemoryMap. Neither N-BASIC nor N88-BASIC's
  // boot-to-banner path writes here, so leaving it un-mapped
  // doesn't block first-light.
  textWindow: u8 = 0;

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
      eromSelection: this.eromSelection,
      textWindow: this.textWindow,
    };
  }

  fromSnapshot(s: SystemControllerSnapshot): void {
    this.dipSwitch1 = s.dipSwitch1;
    this.dipSwitch2 = s.dipSwitch2;
    this.systemStatus = s.systemStatus;
    this.eromSelection = s.eromSelection;
    this.textWindow = s.textWindow;
  }

  constructor(
    private readonly memoryMap: PC88MemoryMap,
    private readonly beeper: Beeper,
    dips: DIPSwitchState,
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
      write: (_p, v) => this.memoryMap.setGVRAMPlane((v & 0x03) as 0 | 1 | 2),
    });
    bus.register(0x70, {
      name: "sysctrl/0x70",
      read: () => this.textWindow,
      write: (_p, v) => this.handle70(v),
    });
    bus.register(0x71, {
      name: "sysctrl/0x71",
      read: () => this.eromSelection,
      write: (_p, v) => this.handle71(v),
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
    const mmode = ((v >> 1) & 0x01) as 0 | 1;
    const rmode = ((v >> 2) & 0x01) as 0 | 1;
    const graph = v & 0x08 ? "graphics" : "none";
    const hcolor = v & 0x10 ? "color" : "mono";
    const highres = (v & 0x20) !== 0;

    log.info(
      `0x31 write: lines=${lines} mmode=${mmode === 0 ? "rom" : "ram"} rmode=${rmode === 0 ? "n88" : "n80"} graph=${graph} hcolor=${hcolor} highres=${highres}`,
    );

    // Earlier code propagated `mmode` to setBasicRomEnabled() and
    // `rmode` to setBasicMode() on every port-0x31 write, on the
    // theory that the BIOS would use those bits to flip BASIC modes
    // at runtime. That tripped the BIOS into "ROM mapped out"
    // mid-init and stuck it before CRTC programming. Cold-boot DIP
    // selection is handled in PC88Machine.reset() instead.
    //
    // We DO latch mmode + rmode here for one purpose: gating EROM
    // enablement. Per the maroon.dk port table and the PC-8801 mkII
    // hardware manual, EROM only maps in when mmode=0 (ROM mode) AND
    // rmode=0 (N88-BASIC). When either bit flips, EROM must drop
    // immediately — otherwise N88-BASIC's runtime ROM-bank swap
    // would leave a stale EROM image at 0x6000 across a mode change.
    this.mmode = mmode;
    this.rmode = rmode;
    this.applyEROMEnable();
  }

  /*
   * Port 0x32 (R/W). Not on vanilla PC-8801 — added on mkII onward.
   * Bit layout per MAME's pc8801.cpp `misc_ctrl_w` (transcribed from
   * the NEC PC-8801 mkII Hardware Manual):
   *
   *   bit 7  SINTM  sound-IRQ mask    0=enabled 1=masked
   *   bit 6  GVAM   GVRAM access mode 0=independent 1=ALU
   *   bit 5  PMODE  palette select    0=digital 1=analog
   *   bit 4  TMODE  high-speed RAM    0=dedicated TVRAM chip (SR+)
   *                                   1=main RAM bank (mkI/mkII)
   *   bits 2-3 SCROUT  screen output mode
   *                    00=TV/video 01=disabled 10=analog-RGB 11=optional
   *   bits 0-1 EROMSL  internal EROM slot select
   *
   * TMODE on pre-SR machines is meaningless because there is no
   * dedicated TVRAM chip — `tvramSeparate` in MemoryConfig defaults
   * to false on those variants. On SR onwards bit 4 is a runtime
   * toggle the BIOS uses to switch between the two TVRAM sources;
   * we'll wire that to PC88MemoryMap when SR boot work starts.
   */
  private handle32(v: u8): void {
    const eromsl = v & 0x03;
    const scrout = (
      {
        0x00: "tv-video",
        0x04: "disabled",
        0x08: "analog-rgb",
        0x0c: "optional",
      } as const
    )[v & 0x0c];
    const tmode = v & 0x10 ? "main-ram" : "dedicated-tvram";
    const pmode = v & 0x20 ? "analog" : "digital";
    const gvam = v & 0x40 ? "alu" : "independent";
    const sintm = v & 0x80 ? "masked" : "enabled";

    log.info(
      `0x32 write: eromsl=${eromsl} scrout=${scrout} tmode=${tmode} pmode=${pmode} gvam=${gvam} sintm=${sintm}`,
    );

    // bits 0-1 select the active extension-ROM slot, but they don't
    // gate enablement. The enable signal lives on port 0x71 (one-hot
    // slot bits) and is further gated on RMODE=MMODE=0. Earlier code
    // collapsed select+enable here as `setEROMEnabled(eromsl === 0)`,
    // matching N-BASIC's empirical boot but breaking N88's E1/E2/E3
    // path. Now port 0x32 only updates the slot index; whether the
    // selected slot maps in is decided by applyEROMEnable() the next
    // time port 0x71 or port 0x31 changes (or right now, since the
    // slot index is part of "what enable means").
    this.memoryMap.setEROMSlot((eromsl & 0x03) as 0 | 1 | 2 | 3);
    this.applyEROMEnable();
  }

  private handle70(v: u8): void {
    // Latch the value; surface a warning so we notice the first time
    // a real boot path uses the Text Window. Once we have evidence of
    // which source ROM this maps from, hook up PC88MemoryMap to
    // expose the 1 KB at 0x8000-0x83FF when MMODE=0 && RMODE=0.
    this.textWindow = v;
    log.warn(
      `0x70 write: textWindow=${byte(v)} (1 KB at ${byte(v)}00-${byte(v)}3FF) — mapping not yet implemented`,
    );
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

  private handle71(v: u8): void {
    // One-hot, active-low slot selection: the lowest clear bit in
    // bits 0..3 picks the active EROM slot. Bits 4..7 are described
    // in some references as additional ROM banks beyond the four
    // extension slots, but the hardware they correspond to is
    // documented inconsistently — neither the PC-8801 nor mkII
    // wire all eight, and which models do is unclear. Log a warning
    // when the BIOS clears any of them so we notice if a real boot
    // depends on them.
    const slotBits = v & 0x0f;
    const upperBits = v & 0xf0;
    if (upperBits !== 0xf0) {
      log.warn(
        `0x71 write: high bits ${byte(upperBits)} clear — ROMs 4-7 not modelled`,
      );
    }

    if (slotBits !== 0x0f) {
      // At least one slot bit clear → that slot is "selected" for
      // enablement. If multiple are clear (unusual), the lowest
      // wins. Real silicon's behaviour with multiple bits clear is
      // model-specific; this matches the convention older emulators use.
      let slot: 0 | 1 | 2 | 3 = 0;
      if ((v & 0x01) === 0) slot = 0;
      else if ((v & 0x02) === 0) slot = 1;
      else if ((v & 0x04) === 0) slot = 2;
      else if ((v & 0x08) === 0) slot = 3;
      this.memoryMap.setEROMSlot(slot);
    }

    this.eromSelection = v;
    this.applyEROMEnable();

    log.info(
      `0x71 write: eromsl=${this.memoryMap.eromSlot}/${this.memoryMap.eromEnabled} raw=${byte(v)}`,
    );
  }

  // EROM is mapped in when ALL of the following hold:
  //   - mmode = 0 (port 0x31 bit 1 → ROM at 0x0000-0x7FFF, not RAM)
  //   - rmode = 0 (port 0x31 bit 2 → N88-BASIC selected)
  //   - at least one of port 0x71 bits 0..3 is clear (slot enabled)
  // Per maroon.dk's PC-88 port reference + the mkII hardware manual.
  // Earlier the enable was driven solely by `eromsl == 0` on port
  // 0x32, which let EROM map even when the BIOS had banked-out the
  // ROM range or switched to N80; both broke real boot paths.
  private applyEROMEnable(): void {
    const slotEnabled = (this.eromSelection & 0x0f) !== 0x0f;
    const gateOpen = this.mmode === 0 && this.rmode === 0;
    this.memoryMap.setEROMEnabled(slotEnabled && gateOpen);
  }
}
