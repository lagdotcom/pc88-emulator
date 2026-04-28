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
