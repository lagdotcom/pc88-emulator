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
    bus.register(0x50, {
      name: "crtc/cmd",
      write: (_p, v) => this.writeCommand(v),
    });
    bus.register(0x51, {
      name: "crtc/data",
      read: () => this.status,
      write: (_p, v) => this.writeParam(v),
    });
  }

  private writeCommand(v: u8): void {
    this.command = v;
    this.paramsLeft = PARAM_COUNT[v] ?? 5;
    this.params = [];
    log.debug(`cmd 0x${v.toString(16)}, expects ${this.paramsLeft} params`);
  }

  private writeParam(v: u8): void {
    if (this.paramsLeft <= 0 || this.command === null) {
      log.debug(`stray data 0x${v.toString(16)}`);
      return;
    }
    this.params.push(v);
    this.paramsLeft--;
    if (this.paramsLeft === 0) {
      log.debug(
        `cmd 0x${this.command.toString(16)} params [${this.params
          .map((b) => "0x" + b.toString(16))
          .join(",")}]`,
      );
      this.command = null;
    }
  }
}
