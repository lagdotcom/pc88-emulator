import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestCase } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(HERE, "data", "v1");
const SOURCE = "https://raw.githubusercontent.com/SingleStepTests/z80/main/v1";

export async function loadTests(opName: string): Promise<TestCase[]> {
  const filename = `${opName}.json`;
  const cached = join(DATA_DIR, filename);
  if (!existsSync(cached)) {
    await mkdir(DATA_DIR, { recursive: true });
    const url = `${SOURCE}/${encodeURIComponent(filename)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `failed to fetch ${url}: ${res.status} ${res.statusText}`,
      );
    }
    const body = await res.text();
    await writeFile(cached, body);
    return JSON.parse(body) as TestCase[];
  }
  const body = await readFile(cached, "utf8");
  return JSON.parse(body) as TestCase[];
}
