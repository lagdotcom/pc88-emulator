// PC-88 keyboard-matrix slot enum. Values pack `row * 8 + col` so a
// caller can split with `>> 3` / `& 7` to drive
// `Keyboard.pressKey(row, col)` (the chip lives at I/O ports
// 0x00-0x0F, one row per port — earlier code mistakenly thought it
// was a PPI; it isn't on PC-88 hardware).
//
// The keyboard is active-low: a `0` bit on a row read means the
// corresponding column is held. Idle (no keys held) reads 0xFF.
//
// Only mkII FH / MH and later expose ports 0x0C..0x0E (extra
// rows + extra modifiers); on earlier models those are open-bus.
// `FH_OR_LATER` (row 14, col 7) reads 0 on FH+ and 1 on the older
// hardware — software uses it to fork between layouts.
export enum PC88Key {
  NUMPAD_0,
  NUMPAD_1,
  NUMPAD_2,
  NUMPAD_3,
  NUMPAD_4,
  NUMPAD_5,
  NUMPAD_6,
  NUMPAD_7,

  NUMPAD_8,
  NUMPAD_9,
  NUMPAD_MULTIPLY,
  NUMPAD_PLUS,
  NUMPAD_EQUALS,
  NUMPAD_FULL_STOP,
  NUMPAD_COMMA,
  RETURN,

  AT,
  A,
  B,
  C,
  D,
  E,
  F,
  G,

  H,
  I,
  J,
  K,
  L,
  M,
  N,
  O,

  P,
  Q,
  R,
  S,
  T,
  U,
  V,
  W,

  X,
  Y,
  Z,
  LEFT_BRACKET,
  YEN_OR_BACKSLASH,
  RIGHT_BRACKET,
  CARET,
  HYPHEN,

  NUM_0,
  NUM_1,
  NUM_2,
  NUM_3,
  NUM_4,
  NUM_5,
  NUM_6,
  NUM_7,

  NUM_8,
  NUM_9,
  COLON,
  SEMICOLON,
  COMMA,
  FULL_STOP,
  SLASH,
  UNDERSCORE,

  HOME_CLR,
  ARROW_UP,
  ARROW_RIGHT,
  INS_DEL,
  GRPH,
  KANA,
  SHIFT,
  CTRL,

  STOP,
  F1,
  F2,
  F3,
  F4,
  F5,
  SPACE,
  ESC,

  HTAB,
  ARROW_DOWN,
  ARROW_LEFT,
  HELP,
  COPY,
  NUMPAD_MINUS,
  NUMPAD_DIVIDE,
  CAPS_LOCK,

  ROLL_UP,
  ROLL_DOWN,

  // FH and later only

  F6 = 96,
  F7,
  F8,
  F9,
  F10,
  BS,
  INS,
  DEL,

  CONVERSION,
  DECISION,
  PC,
  FULL_WIDTH,

  RETURN_MAIN = 112,
  NUMPAD_RETURN,
  LEFT_SHIFT,
  RIGHT_SHIFT,
  FH_OR_LATER = 119,
}
