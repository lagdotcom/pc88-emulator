import { describe, expect, it } from "vitest";

import { md5 } from "../../src/web/md5.js";

const enc = new TextEncoder();
const hash = (s: string): string => md5(enc.encode(s));

describe("md5", () => {
  // RFC 1321 test vectors.
  it("hashes the empty string", () => {
    expect(hash("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("hashes 'a'", () => {
    expect(hash("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
  });

  it("hashes 'abc'", () => {
    expect(hash("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });

  it("hashes 'message digest'", () => {
    expect(hash("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
  });

  it("hashes 'abcdefghijklmnopqrstuvwxyz'", () => {
    expect(hash("abcdefghijklmnopqrstuvwxyz")).toBe(
      "c3fcd3d76192e4007dfb496cca67e13b",
    );
  });

  it("hashes 'A' * 80 (crosses a 64-byte block)", () => {
    expect(hash("A".repeat(80))).toBe("d1d9abe750525b2b6c74a5291f52baa7");
  });

  it("hashes a 32 KB ROM-sized buffer of zeros", () => {
    // Computed by `node -e "crypto.createHash('md5').update(Buffer.alloc(32768))..."`.
    const buf = new Uint8Array(32 * 1024);
    expect(md5(buf)).toBe("bb7df04e1b0a2570657527a7e108ae23");
  });
});
