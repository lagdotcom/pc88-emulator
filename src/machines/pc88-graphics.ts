import logLib from "log";

import type { IOBus } from "../core/IOBus.js";
import { byte } from "../tools.js";

const log = logLib.get("gfx");

// TODO add this to Snapshotting
export class PC88Graphics {
  bgColor = 0;
  showText = false;
  showGVRAM0 = false;
  showGVRAM1 = false;
  showGVRAM2 = false;
  showGVRAM3 = false;

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
