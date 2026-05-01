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
