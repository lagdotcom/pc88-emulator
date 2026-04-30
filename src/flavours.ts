interface Flavouring<FlavourT> {
  _type?: FlavourT;
}
export type Flavour<T, FlavourT> = T & Flavouring<FlavourT>;

export type u8 = Flavour<number, "u8">;
export type u16 = Flavour<number, "u16">;

export type s8 = Flavour<number, "s8">;
export type s16 = Flavour<number, "s16">;

export type Bytes = Flavour<number, "Bytes">;
export type Kilobytes = Flavour<number, "Kilobytes">;

export type Operations = Flavour<number, "Operations">;
export type Cycles = Flavour<number, "Cycles">;
export type Milliseconds = Flavour<number, "Milliseconds">;
export type Seconds = Flavour<number, "Seconds">;
export type Minutes = Flavour<number, "Minutes">;
export type Hours = Flavour<number, "Hours">;

export type Hertz = Flavour<number, "Hertz">;

export type Chars = Flavour<number, "Chars">;
export type Pixels = Flavour<number, "Pixels">;

export type FilesystemPath = Flavour<string, "FilesystemPath">;
export type WebURI = Flavour<string, "WebURI">;

export type MD5Sum = Flavour<string, "MD5Sum">;

export type ROMID = Flavour<string, "ROMID">;
