import logLib from "log";

import type { IOBus } from "../core/IOBus.js";
import type { u8 } from "../flavours.js";
import { byte } from "../tools.js";

const log = logLib.get("gfx");

export interface PC88GraphicsSnapshot {
  bgColor: u8;
  showText: boolean;
  showGVRAM0: boolean;
  showGVRAM1: boolean;
  showGVRAM2: boolean;
  showGVRAM3: boolean;
}

export class PC88Graphics {
  bgColor: u8 = 0;
  showText = false;
  showGVRAM0 = false;
  showGVRAM1 = false;
  showGVRAM2 = false;
  showGVRAM3 = false;

  snapshot(): PC88GraphicsSnapshot {
    return {
      bgColor: this.bgColor,
      showText: this.showText,
      showGVRAM0: this.showGVRAM0,
      showGVRAM1: this.showGVRAM1,
      showGVRAM2: this.showGVRAM2,
      showGVRAM3: this.showGVRAM3,
    };
  }

  fromSnapshot(s: PC88GraphicsSnapshot): void {
    this.bgColor = s.bgColor;
    this.showText = s.showText;
    this.showGVRAM0 = s.showGVRAM0;
    this.showGVRAM1 = s.showGVRAM1;
    this.showGVRAM2 = s.showGVRAM2;
    this.showGVRAM3 = s.showGVRAM3;
  }

  register(bus: IOBus): void {
    bus.register(0x52, {
      name: "gfx/bg",
      read: () => {
        log.info(`0x52 read`);
        return 0xff;
      },
      write: (port, v) => {
        this.bgColor = (v & 0x70) >> 4;
        log.info(`0x52 write: bgColor=${byte(v)}`);
      },
    });

    bus.register(0x53, {
      name: "gfx/display",
      read: () => {
        log.info(`0x53 read`);
        return 0xff;
      },
      write: (port, v) => {
        this.showText = (v & 0x01) === 0;
        this.showGVRAM0 = (v & 0x02) === 0;
        this.showGVRAM1 = (v & 0x04) === 0;
        this.showGVRAM2 = (v & 0x08) === 0;
        this.showGVRAM3 = (v & 0x10) === 0;

        log.info(
          `0x53 write: text=${this.showText} g0=${this.showGVRAM0} g1=${this.showGVRAM1} g2=${this.showGVRAM2} g3=${this.showGVRAM3}`,
        );
      },
    });

    for (let i = 0; i < 8; i++)
      bus.register(0x54 + i, {
        name: `gfx/pal${i}`,
        read: () => {
          log.info(`pal/${i} read`);
          return 0xff;
        },
        write: (port, v) => {
          log.info(`pal/${i} wrote: 0x${byte(v)}`);
        },
      });

    bus.register(0x5c, {
      name: "gfx/5c",
      read: () => {
        log.info("0x5c read");
        return 0xff;
      },
      write: (port, v) => {
        log.info(`0x5c wrote: 0x${byte(v)}`);
      },
    });
    bus.register(0x5d, {
      name: "gfx/5d",
      read: () => {
        log.info("0x5d read");
        return 0xff;
      },
      write: (port, v) => {
        log.info(`0x5d wrote: 0x${byte(v)}`);
      },
    });
    bus.register(0x5e, {
      name: "gfx/5e",
      read: () => {
        log.info("0x5e read");
        return 0xff;
      },
      write: (port, v) => {
        log.info(`0x5e wrote: 0x${byte(v)}`);
      },
    });
    bus.register(0x5f, {
      name: "gfx/5f",
      read: () => {
        log.info("0x5f read");
        return 0xff;
      },
      write: (port, v) => {
        log.info(`0x5f wrote: 0x${byte(v)}`);
      },
    });
  }
}
