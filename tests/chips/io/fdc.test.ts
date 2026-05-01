import { describe, expect, it } from "vitest";

import { CMD, MSR, ST0, ST3, μPD765a } from "../../../src/chips/io/μPD765a.js";
import { IOBus } from "../../../src/core/IOBus.js";
import { D88Disk, makeSector } from "../../../src/disk/d88.js";
import { FloppyDrive } from "../../../src/disk/drive.js";
import type { Sector } from "../../../src/disk/types.js";
import type {
  Cylinder,
  Head,
  Record,
  SizeCode,
} from "../../../src/flavours.js";

const C = (n: number) => n as Cylinder;
const H = (n: number) => n as Head;
const R = (n: number) => n as Record;
const N = (n: number) => n as SizeCode;

function fillData(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed + i) & 0xff;
  return out;
}

function buildDisk(): D88Disk {
  const tracks: ({ cylinder: Cylinder; head: Head; sectors: Sector[] } | undefined)[] = [];
  for (let c = 0; c < 3; c++) {
    for (let h = 0; h < 2; h++) {
      const sectors: Sector[] = [];
      for (let r = 1; r <= 4; r++) {
        sectors.push(
          makeSector(C(c), H(h), R(r), N(1), fillData(c * 100 + h * 10 + r, 256)),
        );
      }
      tracks[c * 2 + h] = { cylinder: C(c), head: H(h), sectors };
    }
  }
  return new D88Disk({
    name: "FDCTEST",
    mediaType: "2D",
    cylinders: 3,
    writeProtected: false,
    tracks,
  });
}

function setup() {
  const bus = new IOBus();
  const fdc = new μPD765a();
  fdc.register(bus);
  const drive0 = new FloppyDrive();
  drive0.insert(buildDisk());
  drive0.motorOn = true;
  fdc.attachDrive(0, drive0);
  return { bus, fdc, drive0 };
}

function readResult(bus: IOBus, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(bus.read(0xfb));
  }
  return out;
}

function writeCmd(bus: IOBus, ...bytes: number[]): void {
  for (const b of bytes) bus.write(0xfb, b);
}

describe("μPD765a phases + MSR", () => {
  it("idle MSR: RQM | NDM, DIO clear, CB clear", () => {
    const { bus } = setup();
    const msr = bus.read(0xfa);
    expect(msr & MSR.RQM).toBe(MSR.RQM);
    expect(msr & MSR.NDM).toBe(MSR.NDM);
    expect(msr & MSR.DIO).toBe(0);
    expect(msr & MSR.CB).toBe(0);
  });

  it("CB asserts in command/result phases", () => {
    const { bus } = setup();
    bus.write(0xfb, CMD.SENSE_DRIVE_STATUS);
    expect(bus.read(0xfa) & MSR.CB).toBe(MSR.CB);
    bus.write(0xfb, 0x00); // drive 0, head 0
    expect(bus.read(0xfa) & MSR.CB).toBe(MSR.CB);
    expect(bus.read(0xfa) & MSR.DIO).toBe(MSR.DIO);
    bus.read(0xfb); // drain ST3
    expect(bus.read(0xfa) & MSR.CB).toBe(0);
  });

  it("invalid command returns ST0 = invalid-command in a 1-byte result", () => {
    const { bus } = setup();
    bus.write(0xfb, 0x1f);
    expect(bus.read(0xfa) & MSR.DIO).toBe(MSR.DIO);
    const r = readResult(bus, 1);
    expect(r[0]! & ST0.IC_MASK).toBe(ST0.IC_INVALID_CMD);
  });
});

describe("μPD765a SPECIFY", () => {
  it("latches SRT/HUT/HLT/ND, no IRQ, no result", () => {
    const { bus, fdc } = setup();
    let irq = 0;
    fdc.onInterrupt = () => irq++;
    writeCmd(bus, CMD.SPECIFY, 0xa3, 0x12);
    expect(irq).toBe(0);
    expect(bus.read(0xfa) & MSR.CB).toBe(0);
    const snap = fdc.snapshot();
    expect(snap.srt).toBe(0xa);
    expect(snap.hut).toBe(0x3);
    expect(snap.hlt).toBe((0x12 >>> 1) & 0x7f);
    expect(snap.nonDma).toBe(false);
  });
});

describe("μPD765a SENSE DRIVE STATUS", () => {
  it("returns ST3 with TS, RY, T0 set on a ready drive at track 0", () => {
    const { bus } = setup();
    writeCmd(bus, CMD.SENSE_DRIVE_STATUS, 0x00); // drive 0, head 0
    const [st3] = readResult(bus, 1);
    expect(st3! & ST3.TS).toBe(ST3.TS);
    expect(st3! & ST3.RY).toBe(ST3.RY);
    expect(st3! & ST3.T0).toBe(ST3.T0);
    expect(st3! & ST3.WP).toBe(0);
  });

  it("clears RY when motor is off", () => {
    const { bus, drive0 } = setup();
    drive0.motorOn = false;
    writeCmd(bus, CMD.SENSE_DRIVE_STATUS, 0x00);
    const [st3] = readResult(bus, 1);
    expect(st3! & ST3.RY).toBe(0);
  });

  it("does not crash on an unattached drive (drive 1)", () => {
    const { bus } = setup();
    writeCmd(bus, CMD.SENSE_DRIVE_STATUS, 0x01); // drive 1
    const [st3] = readResult(bus, 1);
    expect(st3! & ST3.RY).toBe(0);
    expect(st3! & ST3.US0).toBe(ST3.US0);
  });
});

describe("μPD765a RECALIBRATE + SENSE INTERRUPT STATUS", () => {
  it("steps drive to track 0 and surfaces SE + PCN via SENSE INT", () => {
    const { bus, fdc, drive0 } = setup();
    drive0.step(1);
    drive0.step(1);
    expect(drive0.cylinder).toBe(2);
    let irqs = 0;
    fdc.onInterrupt = () => irqs++;
    writeCmd(bus, CMD.RECALIBRATE, 0x00);
    expect(irqs).toBe(1);
    expect(drive0.cylinder).toBe(0);

    writeCmd(bus, CMD.SENSE_INTERRUPT_STATUS);
    const [st0, pcn] = readResult(bus, 2);
    expect(st0! & ST0.SE).toBe(ST0.SE);
    expect(pcn).toBe(0);
  });

  it("polling SENSE INT with no pending seek returns invalid-command ST0", () => {
    const { bus } = setup();
    writeCmd(bus, CMD.SENSE_INTERRUPT_STATUS);
    const [st0] = readResult(bus, 1);
    expect(st0! & ST0.IC_MASK).toBe(ST0.IC_INVALID_CMD);
  });
});

describe("μPD765a SEEK", () => {
  it("steps drive to NCN and surfaces PCN via SENSE INT", () => {
    const { bus, drive0 } = setup();
    writeCmd(bus, CMD.SEEK, 0x00, 0x02);
    expect(drive0.cylinder).toBe(2);

    writeCmd(bus, CMD.SENSE_INTERRUPT_STATUS);
    const [st0, pcn] = readResult(bus, 2);
    expect(st0! & ST0.SE).toBe(ST0.SE);
    expect(pcn).toBe(2);
  });
});

describe("μPD765a READ ID", () => {
  it("returns the next sector ID under the head", () => {
    const { bus } = setup();
    writeCmd(bus, CMD.READ_ID | CMD.MF, 0x00); // drive 0, head 0, MFM
    const [, , , c, h, r, n] = readResult(bus, 7);
    expect(c).toBe(0);
    expect(h).toBe(0);
    expect(r).toBe(1);
    expect(n).toBe(1);
  });

  it("flags ND/MA for an unformatted track", () => {
    const { bus, drive0 } = setup();
    drive0.cylinder = 60 as Cylinder;
    writeCmd(bus, CMD.READ_ID | CMD.MF, 0x00);
    const r = readResult(bus, 7);
    expect(r[0]! & ST0.IC_MASK).toBe(ST0.IC_ABNORMAL);
    expect(r[1]! & 0x05).not.toBe(0); // ST1.MA | ST1.ND
  });
});

describe("μPD765a READ DATA", () => {
  it("streams one sector through the data register", () => {
    const { bus } = setup();
    // READ DATA, drive 0, head 0, C=0 H=0 R=1 N=1, EOT=1, GPL=0x1b, DTL=0xff
    writeCmd(bus, CMD.READ_DATA | CMD.MF, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x1b, 0xff);
    const data: number[] = [];
    while (
      (bus.read(0xfa) & (MSR.RQM | MSR.DIO | MSR.CB)) ===
      (MSR.RQM | MSR.DIO | MSR.CB)
    ) {
      data.push(bus.read(0xfb));
      if (data.length > 1024) break;
    }
    // Sector 0/0/1 was filled with seed 0*100 + 0*10 + 1 = 1.
    expect(data.length).toBe(7 + 256);
    expect(data.slice(0, 256)).toEqual(Array.from(fillData(1, 256)));
    const result = data.slice(256);
    expect(result[0]! & ST0.IC_MASK).toBe(ST0.IC_NORMAL);
  });

  it("flags ND when the sector ID is not on the track", () => {
    const { bus } = setup();
    writeCmd(bus, CMD.READ_DATA | CMD.MF, 0x00, 0x00, 0x00, 0x99, 0x01, 0x01, 0x1b, 0xff);
    const r = readResult(bus, 7);
    expect(r[0]! & ST0.IC_MASK).toBe(ST0.IC_ABNORMAL);
    expect(r[1]! & 0x04).toBe(0x04); // ST1.ND
  });

  it("returns NR / abnormal when no disk is in the drive", () => {
    const fdc = new μPD765a();
    const bus = new IOBus();
    fdc.register(bus);
    const empty = new FloppyDrive();
    fdc.attachDrive(0, empty);
    writeCmd(bus, CMD.READ_DATA | CMD.MF, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x1b, 0xff);
    const r = readResult(bus, 1);
    expect(r[0]! & ST0.IC_MASK).toBe(ST0.IC_ABNORMAL);
    expect(r[0]! & ST0.NR).toBe(ST0.NR);
  });
});

describe("μPD765a IRQ + snapshot", () => {
  it("fires onInterrupt on command completion and clears on result drain", () => {
    const { bus, fdc } = setup();
    let irqs = 0;
    fdc.onInterrupt = () => irqs++;
    writeCmd(bus, CMD.SEEK, 0x00, 0x02);
    expect(irqs).toBe(1);
    writeCmd(bus, CMD.SENSE_INTERRUPT_STATUS);
    readResult(bus, 2);
    expect(fdc.snapshot().irqAsserted).toBe(false);
  });

  it("survives a snapshot round-trip mid-command", () => {
    const { bus, fdc } = setup();
    writeCmd(bus, CMD.SEEK, 0x00, 0x02);
    writeCmd(bus, CMD.SENSE_INTERRUPT_STATUS);
    const snap = fdc.snapshot();

    const fresh = new μPD765a();
    fresh.fromSnapshot(snap);
    const reconstituted = JSON.parse(JSON.stringify(fresh.snapshot()));
    expect(reconstituted).toEqual(snap);
  });
});
