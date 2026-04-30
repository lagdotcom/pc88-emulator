import type { Cycles, Hertz, Milliseconds, Operations } from "./flavours.js";

export const kOps = (v: number): Operations => v * 1_000;
export const mOps = (v: number): Operations => v * 1_000_000;
export const bOps = (v: number): Operations => v * 1_000_000_000;

export const mCycles = (v: number): Cycles => v * 1_000_000;

export const mHz = (v: number): Hertz => v * 1_000_000;

export const minutesToMs = (v: number): Milliseconds => v * 60_000;
