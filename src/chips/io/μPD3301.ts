import logLib from "log";

import type { IOBus } from "../../core/IOBus.js";
import type { u8 } from "../../flavours.js";

const log = logLib.get("crtc");

// μPD3301 stub. The CRTC takes a command byte at 0x50 followed by a
// command-specific run of parameter bytes. For first-light we accept
// the command sequence — enough to keep the BIOS from looping on the
// status read — but don't drive a renderer. The status surface at
// 0x51 returns "ready" with VBL bit toggled by the runner.
//
// Real chip command set (only the ones BASIC actually issues during
// init are tracked here; the rest fall through to the default param
// count of 5 from the data sheet):
//   0x40  RESET            0 params
//   0x47  START DISPLAY    0 params  (mkI BASIC issues this)
//   0x44  STOP DISPLAY     0 params
//   0x60  RESET COUNTERS   0 params
//   0x21  LOAD CURSOR      2 params
//   0x53  LIGHT-PEN ENABLE 0 params
//   0x80–0x9F  SET MODE    5 params (the big one BASIC sends at boot)
const PARAM_COUNT: Record<number, number> = {
  0x40: 0,
  0x44: 0,
  0x47: 0,
  0x60: 0,
  0x21: 2,
  0x53: 0,
};

export class μPD3301 {
  // Status bits surfaced at 0x51. Bit 4 is VBL, set by the runner's
  // VBL pump. Other bits report "ready" (real chip uses bit 7 for
  // light-pen, etc.; we don't model those).
  status: u8 = 0x80;

  // Parsed SET MODE parameters (the 5-byte block following an 0x80
  // command). The display surface uses these to know what region of
  // TVRAM the CRTC actually visualises. Initialised to "not yet
  // programmed" so PC88TextDisplay can fall back to a whole-TVRAM
  // dump until BASIC issues a SET MODE.
  charsPerRow = 0; // params[0] + 2 in real hardware
  rowsPerScreen = 0; // params[1] & 0x3F + 1
  attrPairsPerRow = 0; // params[2] & 0x1F (0 = no attribute area)
  charHeightLines = 0; // params[3] & 0x1F + 1
  // True after CRTC START DISPLAY (cmd 0x47); cleared by STOP
  // DISPLAY (0x44) or RESET (0x40). When false, the screen would
  // render as a blank raster on real hardware.
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
    //   port 0x51 (C/D=1) → COMMAND register (cmd write)
    // Previous wiring had these swapped, which made the BIOS's
    // "command at 0x51 then 5 params at 0x50" sequence look like
    // a stray data byte followed by 5 unrelated commands.
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
    // Commands with no parameters dispatch immediately; 0x47 START
    // DISPLAY and 0x44 STOP DISPLAY are what gate `displayOn` (a real
    // CRTC blanks the raster when stopped).
    if (v === 0x40) {
      // Soft reset — clears parsed mode, drops display.
      this.charsPerRow = 0;
      this.rowsPerScreen = 0;
      this.attrPairsPerRow = 0;
      this.charHeightLines = 0;
      this.displayOn = false;
    } else if (v === 0x47) {
      this.displayOn = true;
    } else if (v === 0x44) {
      this.displayOn = false;
    }
    this.command = v;
    this.paramsLeft = PARAM_COUNT[v] ?? 5;
    this.params = [];
    log.info(`cmd 0x${v.toString(16)}, expects ${this.paramsLeft} params`);
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
      // SET MODE (0x80-0x9F): five-byte parameter block per the
      // μPD3301 datasheet. Encodings used by N-BASIC at boot:
      //   p0: high-bit + chars-per-row-1
      //   p1: bits 0-5 = rows-1; bit 7 = transparent attr mode
      //   p2: bits 0-4 = attribute pairs per row (0 = none)
      //   p3: bits 0-4 = char height - 1
      //   p4: cursor / blink config
      if ((cmd & 0xe0) === 0x80) {
        const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = this.params;
        this.charsPerRow = (p0 & 0x7f) + 2;
        this.rowsPerScreen = (p1 & 0x3f) + 1;
        this.attrPairsPerRow = p2 & 0x1f;
        this.charHeightLines = (p3 & 0x1f) + 1;
        log.info(
          `SET MODE: ${this.charsPerRow}x${this.rowsPerScreen}, ` +
            `attr-pairs/row=${this.attrPairsPerRow}, ` +
            `char-height=${this.charHeightLines}`,
        );
      }
      this.command = null;
    }
  }
}
