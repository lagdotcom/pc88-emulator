import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import type { FilesystemPath } from "../../flavours.js";
import {
  parseSymbolFile,
  serialiseSymbolFile,
  type SymbolFile,
} from "./symbols.js";

// Node-side disk I/O for symbol files. Split out from symbols.ts so
// the browser bundle can use the pure parse / serialise helpers
// without a node:fs static import.

export async function loadSymbolFile(
  path: FilesystemPath,
): Promise<SymbolFile | null> {
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf-8");
  return parseSymbolFile(text, path);
}

export async function saveSymbolFile(file: SymbolFile): Promise<void> {
  await writeFile(file.path, serialiseSymbolFile(file), "utf-8");
}
