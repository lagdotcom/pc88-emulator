import { describe, expect, it } from "vitest";

import { makeSector } from "../../src/disk/d88.js";
import { FloppyDrive } from "../../src/disk/drive.js";
import { WriteProtectedError } from "../../src/disk/types.js";
import {
  buildTestDisk,
  C,
  fillSectorData as fillData,
  H,
  N,
  R,
  S,
} from "../tools.js";

const buildDisk = (opts: { writeProtect?: boolean } = {}) =>
  buildTestDisk({ name: "DRIVETEST", writeProtected: opts.writeProtect ?? false });

describe("FloppyDrive insert / eject / ready", () => {
  it("starts empty + not ready", () => {
    const drive = new FloppyDrive();
    expect(drive.hasDisk()).toBe(false);
    expect(drive.isReady()).toBe(false);
    expect(drive.isAtTrack0()).toBe(true);
  });

  it("becomes ready only with both disk and motor on", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    expect(drive.isReady()).toBe(false);
    drive.motorOn = true;
    expect(drive.isReady()).toBe(true);
    drive.eject();
    expect(drive.isReady()).toBe(false);
  });

  it("eject returns the inserted disk and clears state", () => {
    const drive = new FloppyDrive();
    const disk = buildDisk();
    drive.insert(disk);
    drive.rotation = S(2);
    expect(drive.eject()).toBe(disk);
    expect(drive.hasDisk()).toBe(false);
    expect(drive.rotation).toBe(0);
  });

  it("isWriteProtected mirrors the inserted disk", () => {
    const drive = new FloppyDrive();
    expect(drive.isWriteProtected()).toBe(false);
    drive.insert(buildDisk({ writeProtect: true }));
    expect(drive.isWriteProtected()).toBe(true);
  });
});

describe("FloppyDrive head positioning", () => {
  it("step advances the cylinder and clamps at 0", () => {
    const drive = new FloppyDrive();
    drive.step(1);
    drive.step(1);
    expect(drive.cylinder).toBe(2);
    expect(drive.isAtTrack0()).toBe(false);
    drive.step(-1);
    drive.step(-1);
    drive.step(-1);
    expect(drive.cylinder).toBe(0);
    expect(drive.isAtTrack0()).toBe(true);
  });

  it("step clamps at maxCylinder", () => {
    const drive = new FloppyDrive({ maxCylinder: C(5) });
    for (let i = 0; i < 10; i++) drive.step(1);
    expect(drive.cylinder).toBe(5);
  });

  it("recalibrate snaps back to track 0 from any position", () => {
    const drive = new FloppyDrive();
    for (let i = 0; i < 10; i++) drive.step(1);
    drive.recalibrate();
    expect(drive.cylinder).toBe(0);
    expect(drive.isAtTrack0()).toBe(true);
  });
});

describe("FloppyDrive scanForSector", () => {
  it("finds a matching sector at the current cylinder + head", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    const result = drive.scanForSector(H(0), R(2), N(1));
    expect(result).toBeDefined();
    expect(result!.sector.id.r).toBe(2);
    expect(result!.index).toBe(1);
  });

  it("advances rotation past the matched sector for chained reads", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.scanForSector(H(0), R(2), N(1));
    expect(drive.rotation).toBe(2);
    const next = drive.scanForSector(H(0), R(3), N(1));
    expect(next!.index).toBe(2);
    expect(drive.rotation).toBe(3);
  });

  it("reports indexHolePassed when the wrap was needed to find the match", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.rotation = S(3);
    const result = drive.scanForSector(H(0), R(1), N(1));
    expect(result).toBeDefined();
    expect(result!.index).toBe(0);
    expect(result!.indexHolePassed).toBe(true);
  });

  it("does not report indexHolePassed for an immediate match", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    const result = drive.scanForSector(H(0), R(1), N(1));
    expect(result!.indexHolePassed).toBe(false);
  });

  it("scans the cylinder the head is currently on", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.step(1);
    drive.step(1);
    const result = drive.scanForSector(H(1), R(1), N(1));
    expect(result).toBeDefined();
    expect(result!.sector.id.c).toBe(2);
    expect(result!.sector.id.h).toBe(1);
  });

  it("returns undefined with no disk", () => {
    const drive = new FloppyDrive();
    expect(drive.scanForSector(H(0), R(1), N(1))).toBeUndefined();
  });

  it("returns undefined for an unformatted track", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    for (let i = 0; i < 10; i++) drive.step(1);
    expect(drive.scanForSector(H(0), R(1), N(1))).toBeUndefined();
  });

  it("returns undefined when no ID matches", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    expect(drive.scanForSector(H(0), R(99), N(1))).toBeUndefined();
  });
});

describe("FloppyDrive readNextSectorID", () => {
  it("returns the sector at the cursor and advances by 1", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.rotation = S(2);
    const result = drive.readNextSectorID(H(0));
    expect(result!.id.r).toBe(3);
    expect(drive.rotation).toBe(3);
  });

  it("wraps past the index hole", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.rotation = S(3);
    drive.readNextSectorID(H(0));
    expect(drive.rotation).toBe(0);
  });
});

describe("FloppyDrive write paths", () => {
  it("writeSector delegates to the disk + clears nothing", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    const replacement = fillData(0xee, 256);
    drive.writeSector(H(0), S(0), replacement);
    expect(drive.scanForSector(H(0), R(1), N(1))!.sector.data).toEqual(replacement);
  });

  it("writeSector throws WriteProtectedError on a protected disk", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk({ writeProtect: true }));
    expect(() => drive.writeSector(H(0), S(0), fillData(0, 256))).toThrow(
      WriteProtectedError,
    );
  });

  it("writeSector throws if no disk is inserted", () => {
    const drive = new FloppyDrive();
    expect(() => drive.writeSector(H(0), S(0), fillData(0, 256))).toThrow();
  });

  it("formatCurrentTrack rewrites the track and resets the cursor", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.rotation = S(3);
    drive.formatCurrentTrack(H(0), [
      makeSector(C(0), H(0), R(10), N(0), fillData(0, 128)),
      makeSector(C(0), H(0), R(11), N(0), fillData(1, 128)),
    ]);
    expect(drive.rotation).toBe(0);
    const result = drive.scanForSector(H(0), R(11), N(0));
    expect(result).toBeDefined();
    expect(result!.sector.data.length).toBe(128);
  });

  it("formatCurrentTrack throws on a protected disk", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk({ writeProtect: true }));
    expect(() => drive.formatCurrentTrack(H(0), [])).toThrow(WriteProtectedError);
  });
});

describe("FloppyDrive snapshot / restore", () => {
  it("round-trips position state without serialising the disk", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.motorOn = true;
    drive.step(1);
    drive.rotation = S(2);
    const snap = drive.snapshot();
    expect(snap).toEqual({
      motorOn: true,
      cylinder: 1,
      rotation: 2,
      hasDisk: true,
    });

    const fresh = new FloppyDrive();
    fresh.insert(buildDisk());
    fresh.fromSnapshot(snap);
    expect(fresh.motorOn).toBe(true);
    expect(fresh.cylinder).toBe(1);
    expect(fresh.rotation).toBe(2);
  });

  it("survives JSON round-trip", () => {
    const drive = new FloppyDrive();
    drive.insert(buildDisk());
    drive.motorOn = true;
    drive.step(1);
    drive.step(1);
    drive.rotation = S(3);
    const snap = JSON.parse(JSON.stringify(drive.snapshot()));
    const fresh = new FloppyDrive();
    fresh.fromSnapshot(snap);
    expect(fresh.cylinder).toBe(2);
    expect(fresh.rotation).toBe(3);
    expect(fresh.motorOn).toBe(true);
  });
});
