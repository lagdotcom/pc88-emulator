import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";
import { getLogger } from "../../log.js";
import { type DIPSwitchState, PORT30, PORT31 } from "../../machines/config.js";
import type { PC88MemoryMap } from "../../machines/pc88-memory.js";
import { byte, nibble } from "../../tools.js";
import type { Beeper } from "./beeper.js";

const log = getLogger("sysctrl");

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
//
// PORT30 and PORT31 are shared with `src/machines/config.ts` (the DIP
// switch bit definitions) — same physical bits whether you read them
// off the port (DIP state) or interpret a write to the system
// register. Re-exported below from config.ts to keep variant files'
// imports tidy without re-declaring the bit positions.

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
export const PORT40_R = {
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
  // 80-column mode select (mirrors port 0x30 bit 0 / COLS_80). The
  // text display uses this to choose the TVRAM cell stride: 1 byte
  // per cell in 80-col mode (N88-BASIC convention), 2 bytes per
  // cell in 40-col mode (N-BASIC convention). Same physical CRTC
  // programming in both modes; the discriminator is the system
  // register, not a CRTC parameter.
  cols80: boolean;
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

  // Latched PMODE bit (port 0x32 bit 5 / PORT32.PMODE_ANALOG). Tracked
  // here only so we can fire `onPModeChange` on the rising/falling edge
  // — the actual palette protocol lives in DisplayRegisters. SR boots
  // with PMODE=1 (analogue) via `OUT (0x32),0xA8`; pre-SR variants
  // never write port 0x32 and stay at the digital default.
  private pmode: 0 | 1 = 0;

  // Latched port 0x70 ("Text Window"). High byte of a 1 KB ROM
  // window the BIOS can map into 0x8000-0x83FF when MMODE=0,
  // RMODE=0. Source-ROM details aren't yet confirmed (likely a
  // window into BASIC-ROM continuation past 0x7FFF), so we latch
  // the value for snapshots/diagnostics but don't yet wire the
  // mapping to PC88MemoryMap. Neither N-BASIC nor N88-BASIC's
  // boot-to-banner path writes here, so leaving it un-mapped
  // doesn't block first-light.
  textWindow: u8 = 0;

  // 80-col mode select; defaults true to match the typical mkI
  // power-on. Updated from port 0x30 writes (bit 0 / COLS_80) and
  // consumed by PC88TextDisplay to choose TVRAM cell stride.
  cols80 = true;

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
      cols80: this.cols80,
    };
  }

  fromSnapshot(s: SystemControllerSnapshot): void {
    this.dipSwitch1 = s.dipSwitch1;
    this.dipSwitch2 = s.dipSwitch2;
    this.systemStatus = s.systemStatus;
    this.eromSelection = s.eromSelection;
    this.textWindow = s.textWindow;
    this.cols80 = s.cols80;
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
    this.cols80 = (v & PORT30.COLS_80) !== 0;
    const cols = this.cols80 ? 80 : 40;
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

    // RMODE doesn't propagate to setBasicMode() at runtime — the
    // BIOS writes port 0x31 mid-init for unrelated reasons (LINES,
    // GRPH, HCOLOR) and we'd flip BASIC mode underneath it. Cold-
    // boot DIP selection of n80 vs n88 is handled in
    // PC88Machine.reset() instead.
    //
    // MMODE *does* propagate now: when the BIOS sets bit 1 it's
    // explicitly asking for "ROM unmapped, RAM at 0x0000-0x7FFF"
    // — that's the disk-boot transfer-to-RAM step. The EROM gate
    // (only valid when both bits clear) re-evaluates on every
    // write, same as before.
    this.memoryMap.setBasicRomEnabled(mmode === 0);
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
  // Optional notify hook: fires whenever bit 5 of port 0x32 (PMODE)
  // changes value. PC88Machine wires it to DisplayRegisters so the
  // analogue palette's 2-byte protocol toggles in lockstep with the
  // BIOS programming the SR's V2-mode dispatch (port 0x32 = 0xA8).
  // Null when nothing's listening; called only on the rising/falling
  // edge so listeners don't have to compare.
  onPModeChange: ((pmode: 0 | 1) => void) | null = null;

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
    const pmode = (v & PORT32.PMODE_ANALOG ? 1 : 0) as 0 | 1;
    const gvam = v & PORT32.GVAM_ALU ? "alu" : "independent";
    const sintm = v & PORT32.SINTM_MASK ? "masked" : "enabled";

    log.info(
      `0x32 write: eromsl=${eromsl} scrout=${scrout} tmode=${tmode} pmode=${pmode === 1 ? "analog" : "digital"} gvam=${gvam} sintm=${sintm}`,
    );

    if (pmode !== this.pmode) {
      this.pmode = pmode;
      this.onPModeChange?.(pmode);
    }

    // bits 0-1 select the active extension-ROM slot, but they don't
    // gate enablement. The enable signal lives on port 0x71 (one-hot
    // slot bits) and is further gated on RMODE=MMODE=0. Earlier code
    // collapsed select+enable here as `setEROMEnabled(eromsl === 0)`,
    // matching N-BASIC's empirical boot but breaking N88's E1/E2/E3
    // path. Now port 0x32 only updates the slot index; whether the
    // selected slot maps in is decided by applyEROMEnable() the next
    // time port 0x71 or port 0x31 changes (or right now, since the
    // slot index is part of "what enable means").
    this.memoryMap.setEROMSlot((eromsl & PORT32.EROMSL_MASK) as 0 | 1 | 2 | 3);
    this.applyEROMEnable();
  }

  private handle70(v: u8): void {
    // Latch the value; surface a warning so we notice the first time
    // a real boot path uses the Text Window. Once we have evidence of
    // which source ROM this maps from, hook up PC88MemoryMap to
    // expose the 1 KB at 0x8000-0x83FF when MMODE=0 && RMODE=0.
    this.textWindow = v;
    log.warn(
      `0x70 write: textWindow=${byte(v)} (1 KB at ${byte(v)}00-${nibble(v)}3FF) — mapping not yet implemented`,
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
    // Per MAME pc8801.cpp `mem_r`: only port 0x71 bit 0 gates the
    // E-ROM at 0x6000-0x7FFF (mapped when `m_ext_rom_bank & 1 == 0`).
    // The active-slot index comes from port 0x32 bits 0-1
    // (`m_misc_ctrl & 3`), set in handle32 — port 0x71 does NOT
    // pick the slot. Bits 1-3 are written at POST but their use is
    // documented as TODO in MAME ("selection for EXP slot ROMs?")
    // and we don't model EXP slots; log when they're touched in
    // an unexpected pattern but don't act on them.
    // Bits 4-7 are described in some references as additional ROM
    // banks beyond the four extension slots; their wiring is
    // model-specific. Log a warning when they're cleared.
    const upperBits = v & PORT71.EXT_BANK_MASK;
    if (upperBits !== PORT71.EXT_BANK_MASK) {
      log.warn(
        `0x71 write: high bits ${byte(upperBits)} clear — ROMs 4-7 not modelled`,
      );
    }

    this.eromSelection = v;
    this.applyEROMEnable();

    log.info(
      `0x71 write: bit0=${v & 1 ? "off" : "on"} (E-ROM ${this.memoryMap.eromEnabled ? "enabled" : "disabled"}) slot=${this.memoryMap.eromSlot} raw=${byte(v)}`,
    );
  }

  // E-ROM mapping at 0x6000-0x7FFF (per MAME pc8801.cpp `mem_r`):
  //   if (offset >= 0x6000 && offset <= 0x7fff && (m_ext_rom_bank & 1) == 0)
  //     return n88basic_rom_r(0x8000 + (offset & 0x1fff)
  //                           + (0x2000 * (m_misc_ctrl & 3)));
  // Required for E-ROM to read:
  //   - port 0x71 bit 0 = 0 (only bit 0; bits 1-3 are EXP TODO,
  //     bits 4-7 model-specific)
  //   - mmode = 0 (port 0x31 bit 1 cleared — RAM at 0x0000-0x7FFF
  //     would short-circuit the read before E-ROM is checked)
  //   - rmode = 0 (port 0x31 bit 2 cleared — N-BASIC mode would
  //     short-circuit the read before E-ROM is checked)
  // The slot index (0..3) comes from port 0x32 bits 0-1 and is
  // applied via handle32 → setEROMSlot, NOT from port 0x71's
  // bits 1-3 as some older emulators (and our prior version) did.
  private applyEROMEnable(): void {
    const slotEnabled = (this.eromSelection & 0x01) === 0;
    const gateOpen = this.mmode === 0 && this.rmode === 0;
    this.memoryMap.setEROMEnabled(slotEnabled && gateOpen);
  }
}
