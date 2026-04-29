import { config as loadDotEnv } from "dotenv";
import startNodeLogging from "log-node";

import { PC88Machine, runMachine, type RunOptions } from "./machines/pc88.js";
import type { LoadedRoms } from "./machines/pc88-memory.js";
import { loadRoms } from "./machines/rom-loader.js";
import { MKI } from "./machines/variants/mk1.js";

const DEFAULT_MAX_OPS = 5_000_000;

async function main(): Promise<void> {
  loadDotEnv({ quiet: true });
  startNodeLogging();

  const dir = process.env.PC88_ROM_DIR ?? "roms";
  const loaded = await loadRoms(MKI, { dir });
  if (!loaded.n80 || !loaded.n88 || !loaded.e0) {
    throw new Error(
      `mkI requires n80, n88, e0 ROMs in ${dir}/ (got ${Object.keys(loaded).join(", ")})`,
    );
  }
  const roms: LoadedRoms = {
    n80: loaded.n80,
    n88: loaded.n88,
    e0: loaded.e0,
  };

  const machine = new PC88Machine(MKI, roms);
  machine.reset();

  const opts: RunOptions = {
    maxOps: parseInt(process.env.PC88_MAX_OPS ?? `${DEFAULT_MAX_OPS}`, 10),
  };
  const result = runMachine(machine, opts);

  process.stdout.write("\n--- TVRAM dump ---\n");
  process.stdout.write(machine.display.toAsciiDump());
  process.stdout.write("\n------------------\n");
  process.stdout.write(
    `Ran ${result.ops.toLocaleString()} ops in ${result.cycles.toLocaleString()} cycles (${result.reason}).\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
