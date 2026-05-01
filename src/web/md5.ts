import type { MD5Sum } from "../flavours.js";

// MD5 (RFC 1321) for the browser. WebCrypto.subtle.digest doesn't
// support MD5 (only the SHA family), so we'd otherwise have to pull
// in spark-md5 / blueimp-md5 as a dependency. The descriptors in
// `src/machines/variants/` are all md5-keyed, so to validate ROMs
// in-browser we need it.
//
// Reference: RFC 1321, plus Joseph Myers's public-domain JS
// translation. ~80 lines, ~30 KB/s on a Uint8Array — far faster
// than the user can drop a ROM. No streaming API; ROMs top out
// at 128 KB so a single-shot hash is fine.

const T: number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    out.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));
  }
  return out;
})();

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

function rol(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function add32(a: number, b: number): number {
  return (a + b) | 0;
}

export function md5(bytes: Uint8Array): MD5Sum {
  const len = bytes.length;
  const bitLen = len * 8;
  // Pad to a multiple of 64 bytes: append 0x80, then zeros, then
  // the 64-bit little-endian bit length.
  const padded = new Uint8Array((((len + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  // Bit length as 64-bit LE; ROMs are << 2^32 bits so the high
  // word is always 0, but write both for completeness.
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a = 0x67452301 | 0;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476 | 0;

  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = dv.getInt32(off + i * 4, true);
    }
    let A = a,
      B = b,
      C = c,
      D = d;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      const tmp = D;
      D = C;
      C = B;
      // T and S are fully populated above; the index is bounded by
      // the for-loop. The non-null assertions keep
      // noUncheckedIndexedAccess happy without runtime overhead.
      B = add32(B, rol(add32(add32(add32(A, F), T[i]!), M[g]!), S[i]!));
      A = tmp;
    }
    a = add32(a, A);
    b = add32(b, B);
    c = add32(c, C);
    d = add32(d, D);
  }

  return (toHex(a) + toHex(b) + toHex(c) + toHex(d)) as MD5Sum;
}

function toHex(n: number): string {
  // Emit little-endian byte order (md5 spec) as 8 hex chars.
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return s;
}
