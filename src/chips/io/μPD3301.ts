import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";

const log = logLib.get("crtc");

// μPD3301 stub. Commands are dispatched by the top 3 bits of the
// command byte; the low 5 bits are flags / sub-selectors. This is
// the actual chip behaviour per the NEC μPD3301 datasheet — earlier
// code had an exact-byte table that mismatched what BASIC sends.
//
//   0x00-0x1F  RESET / SET MODE        5 params (the big init block)
//   0x20-0x3F  START DISPLAY           0 params
//   0x40-0x5F  SET INTERRUPT MASK      0 params
//   0x60-0x7F  READ LIGHT PEN          0 params
//   0x80-0x9F  LOAD CURSOR POSITION    2 params
//   0xA0-0xBF  RESET INTERRUPT         0 params
//   0xC0-0xDF  RESET COUNTERS          0 params
//   0xE0-0xFF  READ STATUS             0 params
//
// The chip has no separate STOP DISPLAY command on the PC-88; the
// raster is blanked by RESET or by clearing the START DISPLAY flag.
function paramCount(cmd: number): number {
  switch (cmd & 0xe0) {
    case 0x00:
      return 5;
    case 0x80:
      return 2;
    default:
      return 0;
  }
}

export class μPD3301 {
  // Status bits surfaced by reads at 0x50 / 0x51. Bit 4 is VBL, set
  // by the runner's VBL pump. Other bits report "ready" (real chip
  // uses bit 7 for light-pen, etc.; we don't model those).
  status: u8 = 0x80;

  // Parsed SET MODE state. The display surface uses these to know
  // what region of TVRAM the CRTC actually visualises. Initialised
  // to "not yet programmed" so PC88TextDisplay can fall back to the
  // raw dump until BASIC issues a SET MODE.
  charsPerRow = 0;
  rowsPerScreen = 0;
  attrPairsPerRow = 0;
  charHeightLines = 0;
  // True after START DISPLAY (cmd 0x20-0x3F); cleared by RESET. A
  // real CRTC blanks the raster when this is false; toAsciiDump
  // doesn't enforce that since we'd want to see the banner regardless.
  displayOn = false;

  // Parameter parser state. After a command byte is written we know
  // how many parameter bytes are coming; subsequent writes go into
  // `params` until the count is satisfied.
  private command: number | null = null;
  private paramsLeft = 0;
  private params: number[] = [];

  setVBlank(active: boolean): void {
    if (active) this.status |= 0x10;
    else this.status &= ~0x10;
  }

  register(bus: IOBus): void {
    // PC-88 maps the chip's C/D (command/data) pin to address bit 0:
    //   port 0x50 (C/D=0) → DATA register (parameter write, status read)
    //   port 0x51 (C/D=1) → COMMAND register (cmd write, status read)
    bus.register(0x50, {
      name: "crtc/data",
      read: () => this.status,
      write: (_p, v) => this.writeParam(v),
    });
    bus.register(0x51, {
      name: "crtc/cmd",
      read: () => this.status,
      write: (_p, v) => this.writeCommand(v),
    });
  }

  private writeCommand(v: u8): void {
    const op = v & 0xe0;
    // RESET clears the parsed mode and drops display. Real silicon
    // only fully resets after the 5 follow-up param bytes; we mirror
    // the user-visible bits early so a stale "displayOn" doesn't
    // bleed across a soft reset.
    if (op === 0x00) {
      this.charsPerRow = 0;
      this.rowsPerScreen = 0;
      this.attrPairsPerRow = 0;
      this.charHeightLines = 0;
      this.displayOn = false;
    } else if (op === 0x20) {
      // START DISPLAY: bits [4:0] are display-format flags. We only
      // care that the raster is unblanked.
      this.displayOn = true;
    }
    this.command = v;
    this.paramsLeft = paramCount(v);
    this.params = [];
    log.info(
      `cmd 0x${v.toString(16)} (op 0x${op.toString(16)}), expects ${this.paramsLeft} params`,
    );
    // Zero-param commands complete immediately.
    if (this.paramsLeft === 0) this.command = null;
  }

  private writeParam(v: u8): void {
    if (this.paramsLeft <= 0 || this.command === null) {
      log.info(`stray data 0x${v.toString(16)}`);
      return;
    }
    this.params.push(v);
    this.paramsLeft--;
    if (this.paramsLeft === 0) {
      const cmd = this.command;
      log.info(
        `cmd 0x${cmd.toString(16)} params [${this.params
          .map((b) => "0x" + b.toString(16))
          .join(",")}]`,
      );
      // RESET / SET MODE (0x00-0x1F): 5-byte parameter block per the
      // μPD3301 datasheet. PC-8801 N-BASIC sends [0xCE 0x93 0x69 0xBE
      // 0x13] which decodes to 80 chars × 20 rows.
      //   p0: bits 0-6 = chars-per-row - 2
      //   p1: bits 0-5 = rows - 1
      //   p2: bits 0-4 = attribute pairs per row (active count)
      //   p3: bits 0-4 = character height - 1
      //   p4: cursor / blink config
      if ((cmd & 0xe0) === 0x00) {
        const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = this.params;
        this.charsPerRow = (p0 & 0x7f) + 2;
        this.rowsPerScreen = (p1 & 0x3f) + 1;
        this.attrPairsPerRow = p2 & 0x1f;
        this.charHeightLines = (p3 & 0x1f) + 1;
        log.info(
          `SET MODE: ${this.charsPerRow}x${this.rowsPerScreen}, ` +
            `active-attr-pairs/row=${this.attrPairsPerRow}, ` +
            `char-height=${this.charHeightLines}`,
        );
      }
      this.command = null;
    }
  }
}
