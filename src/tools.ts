import type { s8, s16, u8, u16 } from "./flavours.js";

export const u8Max: u8 = 0xff;

// Typed-array views over a shared 2-byte buffer for cheap u8/u16
// truncation + sign-extension. The shared backing means asU8 and
// asS8 (etc.) read the same lane of memory — writing through u8 and
// reading through s8 sign-extends, etc.
const tempBuffer = new ArrayBuffer(2);
const u8Temp = new Uint8Array(tempBuffer);
const s8Temp = new Int8Array(tempBuffer);
const u16Temp = new Uint16Array(tempBuffer);
const s16Temp = new Int16Array(tempBuffer);

export function asU8(value: number): u8 {
  u8Temp[0] = value;
  return u8Temp[0];
}

export function asS8(value: number): s8 {
  s8Temp[0] = value;
  return s8Temp[0];
}

export function asU16(value: number): u16 {
  u16Temp[0] = value;
  return u16Temp[0];
}

export function asS16(value: number): s16 {
  s16Temp[0] = value;
  return s16Temp[0];
}

export function parity(value: number) {
  let bits = 0;
  while (value) {
    if (value & 1) bits++;
    value >>= 1;
  }

  return bits % 2 == 0;
}

export function nibble(n: number) {
  return n.toString(16);
}

export function byte(n: number) {
  return n.toString(16).padStart(2, "0");
}

export function word(n: number) {
  return n.toString(16).padStart(4, "0");
}

export function hex(n: number, w: number): string {
  return n.toString(16).padStart(w, "0");
}

export function isDefined<T>(value?: T): value is T {
  return typeof value !== "undefined";
}

// Parse a hex / decimal address into a u16. `0x` prefix forces hex;
// otherwise letters-present forces hex; otherwise all-digits is
// decimal. Returns null on garbage input.
//
// Used by the CLI debugger, the standalone `yarn dis` flag parser,
// and any other path that takes user-typed addresses.
export function parseAddrFlag(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s.startsWith("0x")) {
    const n = parseInt(s.slice(2), 16);
    return Number.isFinite(n) ? n & 0xffff : null;
  }
  if (/^[0-9a-f]+$/.test(s) && /[a-f]/.test(s)) {
    return parseInt(s, 16) & 0xffff;
  }
  const dec = parseInt(s, 10);
  return Number.isFinite(dec) ? dec & 0xffff : null;
}
