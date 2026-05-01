import type { PC88Config } from "../config.js";
import { FA } from "./fa.js";
import { FH } from "./fh.js";
import { MA } from "./ma.js";
import { MA2 } from "./ma2.js";
import { MH } from "./mh.js";
import { MKI } from "./mk1.js";
import { MKII } from "./mk2.js";
import { MKII_FR } from "./mk2fr.js";
import { MKII_MR } from "./mk2mr.js";
import { MKII_SR } from "./mk2sr.js";

// Canonical chronological order — drives `--help` listing in the
// CLI and the boot-screen variant dropdown in the web UI.
export const VARIANTS: readonly PC88Config[] = [
  MKI,
  MKII,
  MKII_SR,
  MKII_FR,
  MKII_MR,
  FH,
  MH,
  FA,
  MA,
  MA2,
];

// Lookup by any of the variant's nicknames. Used by the CLI's
// `--machine=NAME` and by the web boot-screen state-restore path.
export const VARIANTS_BY_NICKNAME: Record<string, PC88Config> =
  Object.fromEntries(VARIANTS.flatMap((v) => v.nicknames.map((n) => [n, v])));

// Slugify the model name for use as a stable key (URL hash, OPFS
// settings file, localStorage). Matches the convention used by
// `variantSymbolSlug()` in debug-symbols.ts: lowercase, drop every
// non-`[a-z0-9]`. mkI → `pc8801`, mkII SR → `pc8801mkiisr`.
export function variantSlug(config: PC88Config): string {
  return config.model.toLowerCase().replace(/[^a-z0-9]/g, "");
}
