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
