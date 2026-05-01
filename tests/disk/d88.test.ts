import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { D88Disk, makeSector, parseD88 } from "../../src/disk/d88.js";
import type { Cylinder, Head, Record, SectorIndex, SizeCode } from "../../src/flavours.js";
import { WriteProtectedError, type Sector } from "../../src/disk/types.js";

const C = (n: number) => n as Cylinder;
const H = (n: number) => n as Head;
const R = (n: number) => n as Record;
const N = (n: number) => n as SizeCode;
const S = (n: number) => n as SectorIndex;

function fillData(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed + i) & 0xff;
  return out;
}

function buildSimpleDisk(): D88Disk {
  const tracks: ({ cylinder: Cylinder; head: Head; sectors: Sector[] } | undefined)[] = [];
  for (let c = 0; c < 2; c++) {
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
    name: "TEST",
    mediaType: "2D",
    cylinders: 2,
    writeProtected: false,
    tracks,
  });
}

describe("D88Disk round-trip", () => {
  it("serialises and parses back to the same structure", () => {
    const original = buildSimpleDisk();
    const bytes = original.toBytes();
    const parsed = parseD88(bytes);
    expect(parsed.length).toBe(1);
    const disk = parsed[0]!;
    expect(disk.name).toBe("TEST");
    expect(disk.mediaType).toBe("2D");
    expect(disk.cylinders).toBe(2);
    expect(disk.heads).toBe(2);
    for (let c = 0; c < 2; c++) {
      for (let h = 0; h < 2; h++) {
        const t = disk.getTrack(C(c), H(h))!;
        expect(t.sectors.length).toBe(4);
        for (let r = 1; r <= 4; r++) {
          const match = disk.findSector(C(c), H(h), R(r), N(1))!;
          expect(match.sector.data).toEqual(fillData(c * 100 + h * 10 + r, 256));
          expect(match.sector.status).toBe("ok");
          expect(match.sector.density).toBe("MFM");
        }
      }
    }
  });

  it("preserves a sector data field whose length differs from 128 << N", () => {
    const original = buildSimpleDisk();
    const weird = makeSector(C(0), H(0), R(99), N(1), fillData(7, 137));
    original.formatTrack(C(0), H(0), [
      ...original.getTrack(C(0), H(0))!.sectors,
      weird,
    ]);
    const parsed = parseD88(original.toBytes())[0]!;
    const match = parsed.findSector(C(0), H(0), R(99), N(1))!;
    expect(match.sector.data.length).toBe(137);
    expect(match.sector.data).toEqual(fillData(7, 137));
  });

  it("preserves CRC-error and deleted-mark statuses", () => {
    const disk = new D88Disk({
      name: "PROT",
      mediaType: "2D",
      cylinders: 1,
      writeProtected: false,
      tracks: [
        {
          cylinder: C(0),
          head: H(0),
          sectors: [
            makeSector(C(0), H(0), R(1), N(1), fillData(0, 256), { status: "data-crc" }),
            makeSector(C(0), H(0), R(2), N(1), fillData(0, 256), { deleted: true, status: "deleted" }),
            makeSector(C(0), H(0), R(3), N(1), fillData(0, 256), { status: "no-address-mark" }),
          ],
        },
      ],
    });
    const parsed = parseD88(disk.toBytes())[0]!;
    const t = parsed.getTrack(C(0), H(0))!;
    expect(t.sectors[0]!.status).toBe("data-crc");
    expect(t.sectors[1]!.status).toBe("deleted");
    expect(t.sectors[1]!.deleted).toBe(true);
    expect(t.sectors[2]!.status).toBe("no-address-mark");
  });
});

describe("D88Disk findSector", () => {
  it("scans physical positions wrapping past startAt", () => {
    const disk = buildSimpleDisk();
    const match = disk.findSector(C(0), H(0), R(2), N(1), S(3));
    expect(match).toBeDefined();
    expect(match!.index).toBe(1);
  });

  it("returns undefined for an unformatted track", () => {
    const disk = new D88Disk({
      name: "EMPTY",
      mediaType: "2D",
      cylinders: 1,
      writeProtected: false,
      tracks: [],
    });
    expect(disk.findSector(C(0), H(0), R(1), N(1))).toBeUndefined();
  });

  it("returns undefined when no ID matches", () => {
    const disk = buildSimpleDisk();
    expect(disk.findSector(C(0), H(0), R(99), N(1))).toBeUndefined();
  });
});

describe("D88Disk mutation", () => {
  it("writeSector replaces data and round-trips", () => {
    const disk = buildSimpleDisk();
    const replacement = fillData(0xee, 256);
    disk.writeSector(C(1), H(1), S(0), replacement);
    const parsed = parseD88(disk.toBytes())[0]!;
    const match = parsed.findSector(C(1), H(1), R(1), N(1))!;
    expect(match.sector.data).toEqual(replacement);
  });

  it("writeSector throws on a write-protected disk", () => {
    const disk = buildSimpleDisk();
    disk.writeProtected = true;
    expect(() => disk.writeSector(C(0), H(0), S(0), fillData(0, 256))).toThrow(
      WriteProtectedError,
    );
  });

  it("formatTrack with an empty sector list unformats the track", () => {
    const disk = buildSimpleDisk();
    disk.formatTrack(C(0), H(0), []);
    expect(disk.getTrack(C(0), H(0))).toBeUndefined();
    const parsed = parseD88(disk.toBytes())[0]!;
    expect(parsed.getTrack(C(0), H(0))).toBeUndefined();
    expect(parsed.getTrack(C(0), H(1))).toBeDefined();
  });

  it("write-protect flag survives the round-trip", () => {
    const disk = buildSimpleDisk();
    disk.writeProtected = true;
    const parsed = parseD88(disk.toBytes())[0]!;
    expect(parsed.writeProtected).toBe(true);
  });
});

describe("D88Disk multi-image concatenation", () => {
  it("parses two images back-to-back", () => {
    const a = buildSimpleDisk();
    a.name = "DISK_A";
    const b = buildSimpleDisk();
    b.name = "DISK_B";
    const aBytes = a.toBytes();
    const bBytes = b.toBytes();
    const combined = new Uint8Array(aBytes.length + bBytes.length);
    combined.set(aBytes, 0);
    combined.set(bBytes, aBytes.length);
    const disks = parseD88(combined);
    expect(disks.length).toBe(2);
    expect(disks[0]!.name).toBe("DISK_A");
    expect(disks[1]!.name).toBe("DISK_B");
  });
});

const ROGUE_PATH = join(process.cwd(), "disks", "rogue.d88");
const haveRogue = existsSync(ROGUE_PATH);

describe.skipIf(!haveRogue)("D88Disk Rogue (1986 ASCII)", () => {
  it("parses the structure expected for a 2D disk", () => {
    const bytes = readFileSync(ROGUE_PATH);
    const disks = parseD88(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    expect(disks.length).toBe(1);
    const disk = disks[0]!;
    expect(disk.mediaType).toBe("2D");
    expect(disk.cylinders).toBe(40);
    expect(disk.heads).toBe(2);

    let populated = 0;
    let totalSectors = 0;
    for (let c = 0; c < disk.cylinders; c++) {
      for (let h = 0; h < disk.heads; h++) {
        const t = disk.getTrack(C(c), H(h));
        if (!t) continue;
        populated++;
        totalSectors += t.sectors.length;
      }
    }
    expect(populated).toBe(80);
    expect(totalSectors).toBe(80 * 16);

    const t0 = disk.getTrack(C(0), H(0))!;
    expect(t0.sectors.length).toBe(16);
    expect(t0.sectors[0]!.id.n).toBe(1);
    expect(t0.sectors[0]!.data.length).toBe(256);
    expect(t0.sectors[0]!.density).toBe("MFM");
    expect(t0.sectors[0]!.status).toBe("ok");
  });

  it("re-serialises byte-for-byte", () => {
    const bytes = readFileSync(ROGUE_PATH);
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const disk = parseD88(view)[0]!;
    const out = disk.toBytes();
    expect(out.length).toBe(view.length);
    expect(out).toEqual(view);
  });
});
