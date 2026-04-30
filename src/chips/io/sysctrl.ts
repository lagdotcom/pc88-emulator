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

// Bit fields per port. Names follow MAME's pc8801.cpp internal
// labels so the two codebases grep against each other cleanly. Keep
// these as `const` objects rather than TS `enum`s so they compose
// with the bitwise operators the chip handlers use.

// Port 0x30 (DIP-switch 1 read; system control 1 write).
// Active-high in this convention: a 1 bit means the named state.
const PORT30 = {
  COLS_80: 1 << 0, // 1 = 80 col, 0 = 40 col
  MONO: 1 << 1, // 1 = monochrome, 0 = colour
  CARRIER_MARK: 1 << 2, // 1 = mark, 0 = space
  CASSETTE_MOTOR: 1 << 3, // 1 = on, 0 = off
  USART_MASK: 0b0011_0000, // bits 4-5 — USART rate selector
  USART_CMT600: 0x00,
  USART_CMT1200: 0x10,
  USART_RS232: 0x20, // bits 4-5 = 10 or 11
} as const;

// Port 0x31 (DIP-switch 2 read; system control 2 write).
const PORT31 = {
  LINES_200: 1 << 0, // 1 = 200 lines, 0 = 400 lines (V1/V2)
  MMODE_RAM: 1 << 1, // 1 = RAM at 0x0000-0x7FFF, 0 = ROM
  RMODE_N80: 1 << 2, // 1 = N-BASIC, 0 = N88-BASIC
  GRPH: 1 << 3, // 1 = graphics enabled
  HCOLOR: 1 << 4, // 1 = high-res colour
  HIGHRES: 1 << 5, // 1 = high-res mode
} as const;

// Port 0x32 (misc_ctrl: only on mkII onwards). Per MAME's
// `misc_ctrl_w` comment block.
const PORT32 = {
  EROMSL_MASK: 0b0000_0011, // bits 0-1 — internal EROM slot
  SCROUT_MASK: 0b0000_1100, // bits 2-3 — screen output mode
  SCROUT_TV_VIDEO: 0x00,
  SCROUT_DISABLED: 0x04,
  SCROUT_ANALOG_RGB: 0x08,
  SCROUT_OPTIONAL: 0x0c,
  TMODE_MAIN_RAM: 1 << 4, // 1 = main RAM bank, 0 = dedicated TVRAM (SR+)
  PMODE_ANALOG: 1 << 5, // 1 = analogue palette, 0 = digital
  GVAM_ALU: 1 << 6, // 1 = ALU mode, 0 = independent
  SINTM_MASK: 1 << 7, // 1 = sound IRQ masked, 0 = enabled
} as const;

// Port 0x40 read ("Strobe Port" status — VBL, RTC, printer, etc.).
const PORT40_R = {
  PRINTER_BUSY: 1 << 0,
  SHG_NORMAL_RES: 1 << 1, // 0 = high res, 1 = normal res
  RS232_DCD: 1 << 2, // 1 = data carrier detected
  EXTON: 1 << 3, // active-low: minidisc unit connected
  RTC_DATA_OUT: 1 << 4, // μPD1990A data-out bit
  VBL_ACTIVE: 1 << 5, // 1 = currently in VBL
  UOP1_SW1_7: 1 << 6, // SW1-7 readback
  UOP2_SW1_8: 1 << 7, // SW1-8 readback
} as const;

// Port 0x40 write ("Strobe Port" output — beep, calendar pulses,
// printer strobe, mouse latch).
const PORT40_W = {
  PSTB_NOT: 1 << 0, // active-low printer strobe
  CSTB: 1 << 1, // calendar strobe
  CCK: 1 << 2, // calendar clock
  CLDS_NOT: 1 << 3, // active-low CRT-IF sync init
  GHSM: 1 << 4, // flash mode
  BEEP: 1 << 5, // beeper enable
  UOP1_JOP1: 1 << 6, // mouse latch / general-purpose out 1
  UOP2_SING: 1 << 7, // SING (buzzer mask)
} as const;

// Port 0x71 (EROM bank select). Active-low one-hot in bits 0-3;
// bits 4-7 are described as further ROM banks on some models.
const PORT71 = {
  SLOT_MASK: 0b0000_1111, // bits 0-3 — extension ROM slots E0..E3
  EXT_BANK_MASK: 0b1111_0000, // bits 4-7 — extra ROM banks (model-specific)
  ALL_DISABLED: 0xff,
} as const;

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
    if (active) this.systemStatus |= PORT40_R.VBL_ACTIVE;
    else this.systemStatus &= ~PORT40_R.VBL_ACTIVE;
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
    const cols = v & PORT30.COLS_80 ? 80 : 40;
    const color = v & PORT30.MONO ? "mono" : "color";
    const carrier = v & PORT30.CARRIER_MARK ? "mark" : "space";
    const motor = (v & PORT30.CASSETTE_MOTOR) !== 0;
    const usartLabels: Record<number, string> = {
      [PORT30.USART_CMT600]: "cmt600",
      [PORT30.USART_CMT1200]: "cmt1200",
      [PORT30.USART_RS232]: "rs232c",
      0x30: "rs232c", // bits 4-5 = 11 — also RS-232C per the manual
    };
    const usart = usartLabels[v & PORT30.USART_MASK];

    log.info(
      `0x30 write: cols=${cols} color=${color} carrier=${carrier} motor=${motor} usart=${usart}`,
    );
  }

  private handle31(v: u8): void {
    const lines = v & PORT31.LINES_200 ? 200 : 400;
    const mmode = (v & PORT31.MMODE_RAM ? 1 : 0) as 0 | 1;
    const rmode = (v & PORT31.RMODE_N80 ? 1 : 0) as 0 | 1;
    const graph = v & PORT31.GRPH ? "graphics" : "none";
    const hcolor = v & PORT31.HCOLOR ? "color" : "mono";
    const highres = (v & PORT31.HIGHRES) !== 0;

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
    const eromsl = v & PORT32.EROMSL_MASK;
    const scroutLabels: Record<number, string> = {
      [PORT32.SCROUT_TV_VIDEO]: "tv-video",
      [PORT32.SCROUT_DISABLED]: "disabled",
      [PORT32.SCROUT_ANALOG_RGB]: "analog-rgb",
      [PORT32.SCROUT_OPTIONAL]: "optional",
    };
    const scrout = scroutLabels[v & PORT32.SCROUT_MASK];
    const tmode = v & PORT32.TMODE_MAIN_RAM ? "main-ram" : "dedicated-tvram";
    const pmode = v & PORT32.PMODE_ANALOG ? "analog" : "digital";
    const gvam = v & PORT32.GVAM_ALU ? "alu" : "independent";
    const sintm = v & PORT32.SINTM_MASK ? "masked" : "enabled";

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
    this.memoryMap.setEROMSlot(
      (eromsl & PORT32.EROMSL_MASK) as 0 | 1 | 2 | 3,
    );
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
    const pstb = !(v & PORT40_W.PSTB_NOT);
    const cstb = (v & PORT40_W.CSTB) !== 0;
    const cck = (v & PORT40_W.CCK) !== 0;
    const clds = !(v & PORT40_W.CLDS_NOT);
    const ghsm = (v & PORT40_W.GHSM) !== 0;
    const beep = (v & PORT40_W.BEEP) !== 0;
    const jop1 = (v & PORT40_W.UOP1_JOP1) !== 0;
    const fbeep = (v & PORT40_W.UOP2_SING) !== 0;

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
    const slotBits = v & PORT71.SLOT_MASK;
    const upperBits = v & PORT71.EXT_BANK_MASK;
    if (upperBits !== PORT71.EXT_BANK_MASK) {
      log.warn(
        `0x71 write: high bits ${byte(upperBits)} clear — ROMs 4-7 not modelled`,
      );
    }

    if (slotBits !== PORT71.SLOT_MASK) {
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
    const slotEnabled =
      (this.eromSelection & PORT71.SLOT_MASK) !== PORT71.SLOT_MASK;
    const gateOpen = this.mmode === 0 && this.rmode === 0;
    this.memoryMap.setEROMEnabled(slotEnabled && gateOpen);
  }
}
