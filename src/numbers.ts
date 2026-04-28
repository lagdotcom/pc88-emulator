import type { s8, s16, u8, u16 } from "./flavours.js";

export const u8Max: u8 = 0xff;

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
