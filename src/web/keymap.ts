import { PC88Key } from "../machines/pc88-input.js";

// JS KeyboardEvent.code → PC-88 keyboard-matrix key. The enum values
// in PC88Key are encoded as `row * 8 + col`, so the worker just
// divides + masks to drive `Keyboard.pressKey(row, col)`.
//
// Coverage: full alpha + numeric rows, all standard symbol keys
// available on a US PC layout, the numpad, arrows / Home / Insert /
// Delete / Backspace, modifiers (Shift / Ctrl), and F1..F5 (the
// mkI/mkII matrix). FH+ keys (F6..F10, BS, INS, DEL, RETURN_MAIN,
// LEFT_SHIFT / RIGHT_SHIFT) are mapped where they have a sensible
// host-key equivalent — chip stubs ignore writes to unwired rows
// on pre-FH variants.
//
// Web `KeyboardEvent.code` gives the *physical* key, not the shifted
// character. So Digit2 always maps to NUM_2 even when the user holds
// Shift to type @; the shift state arrives separately as the
// ShiftLeft/Right code, which the BIOS scans as a matrix bit and
// composes itself.

const MAP: Readonly<Record<string, PC88Key>> = {
  // Letters
  KeyA: PC88Key.A,
  KeyB: PC88Key.B,
  KeyC: PC88Key.C,
  KeyD: PC88Key.D,
  KeyE: PC88Key.E,
  KeyF: PC88Key.F,
  KeyG: PC88Key.G,
  KeyH: PC88Key.H,
  KeyI: PC88Key.I,
  KeyJ: PC88Key.J,
  KeyK: PC88Key.K,
  KeyL: PC88Key.L,
  KeyM: PC88Key.M,
  KeyN: PC88Key.N,
  KeyO: PC88Key.O,
  KeyP: PC88Key.P,
  KeyQ: PC88Key.Q,
  KeyR: PC88Key.R,
  KeyS: PC88Key.S,
  KeyT: PC88Key.T,
  KeyU: PC88Key.U,
  KeyV: PC88Key.V,
  KeyW: PC88Key.W,
  KeyX: PC88Key.X,
  KeyY: PC88Key.Y,
  KeyZ: PC88Key.Z,

  // Digits (top row)
  Digit0: PC88Key.NUM_0,
  Digit1: PC88Key.NUM_1,
  Digit2: PC88Key.NUM_2,
  Digit3: PC88Key.NUM_3,
  Digit4: PC88Key.NUM_4,
  Digit5: PC88Key.NUM_5,
  Digit6: PC88Key.NUM_6,
  Digit7: PC88Key.NUM_7,
  Digit8: PC88Key.NUM_8,
  Digit9: PC88Key.NUM_9,

  // Symbol keys — mapped by physical position on a US PC layout.
  // PC-88 doesn't have an exact match for every key (the layout
  // descends from JIS X 6002), so a few of these are best-effort.
  Backquote: PC88Key.AT,
  Minus: PC88Key.HYPHEN,
  Equal: PC88Key.CARET,
  BracketLeft: PC88Key.LEFT_BRACKET,
  BracketRight: PC88Key.RIGHT_BRACKET,
  Backslash: PC88Key.YEN_OR_BACKSLASH,
  Semicolon: PC88Key.SEMICOLON,
  Quote: PC88Key.COLON,
  Comma: PC88Key.COMMA,
  Period: PC88Key.FULL_STOP,
  Slash: PC88Key.SLASH,
  IntlYen: PC88Key.YEN_OR_BACKSLASH,
  IntlRo: PC88Key.UNDERSCORE,

  // Whitespace / line-edit
  Space: PC88Key.SPACE,
  Enter: PC88Key.RETURN,
  Backspace: PC88Key.INS_DEL,
  Tab: PC88Key.HTAB,
  Escape: PC88Key.ESC,

  // Navigation
  ArrowUp: PC88Key.ARROW_UP,
  ArrowDown: PC88Key.ARROW_DOWN,
  ArrowLeft: PC88Key.ARROW_LEFT,
  ArrowRight: PC88Key.ARROW_RIGHT,
  Home: PC88Key.HOME_CLR,
  End: PC88Key.HELP,
  PageUp: PC88Key.ROLL_UP,
  PageDown: PC88Key.ROLL_DOWN,
  Insert: PC88Key.INS,
  Delete: PC88Key.DEL,

  // Modifiers
  ShiftLeft: PC88Key.SHIFT,
  ShiftRight: PC88Key.SHIFT,
  ControlLeft: PC88Key.CTRL,
  ControlRight: PC88Key.CTRL,
  AltLeft: PC88Key.GRPH,
  AltRight: PC88Key.GRPH,
  CapsLock: PC88Key.CAPS_LOCK,

  // Function keys (mkI/mkII expose F1..F5; FH+ adds F6..F10)
  F1: PC88Key.F1,
  F2: PC88Key.F2,
  F3: PC88Key.F3,
  F4: PC88Key.F4,
  F5: PC88Key.F5,
  F6: PC88Key.F6,
  F7: PC88Key.F7,
  F8: PC88Key.F8,
  F9: PC88Key.F9,
  F10: PC88Key.F10,

  // Numpad
  Numpad0: PC88Key.NUMPAD_0,
  Numpad1: PC88Key.NUMPAD_1,
  Numpad2: PC88Key.NUMPAD_2,
  Numpad3: PC88Key.NUMPAD_3,
  Numpad4: PC88Key.NUMPAD_4,
  Numpad5: PC88Key.NUMPAD_5,
  Numpad6: PC88Key.NUMPAD_6,
  Numpad7: PC88Key.NUMPAD_7,
  Numpad8: PC88Key.NUMPAD_8,
  Numpad9: PC88Key.NUMPAD_9,
  NumpadMultiply: PC88Key.NUMPAD_MULTIPLY,
  NumpadAdd: PC88Key.NUMPAD_PLUS,
  NumpadSubtract: PC88Key.NUMPAD_MINUS,
  NumpadDivide: PC88Key.NUMPAD_DIVIDE,
  NumpadDecimal: PC88Key.NUMPAD_FULL_STOP,
  NumpadComma: PC88Key.NUMPAD_COMMA,
  NumpadEqual: PC88Key.NUMPAD_EQUALS,
  NumpadEnter: PC88Key.NUMPAD_RETURN,
};

// Returns null for keys we don't have a PC-88 matrix slot for —
// caller should leave the keyboard state alone for those (the
// browser may still preventDefault for global UI keys).
export function keyCodeToPC88(code: string): PC88Key | null {
  return MAP[code] ?? null;
}

// PC88Key value packs row + col; split for the chip API.
export function rowColFromPC88Key(key: PC88Key): { row: number; col: number } {
  return { row: (key >> 3) & 0xf, col: key & 0x7 };
}
