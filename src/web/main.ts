import { getLogger } from "../log.js";
import { type PC88Config } from "../machines/config.js";
import { PC88Machine, runMachine } from "../machines/pc88.js";
import { loadRomsFromMap } from "../machines/rom-loader-browser.js";
import { type BootRequest, renderBootScreen } from "./boot-screen.js";
import { md5 } from "./md5.js";
import { openStore } from "./opfs.js";

const log = getLogger("web");

// Web entry. For now this is a synchronous boot — the emulator runs
// on the main thread. The Worker boundary lands in a follow-up
// commit; once it's in, this file shrinks to "render the boot screen,
// post a boot message to the worker, render snapshots".

async function main(): Promise<void> {
  const store = await openStore();

  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app element");

  await renderBootScreen(root, {
    store,
    onBoot: (req) => {
      void boot(req, root);
    },
  });
}

async function boot(req: BootRequest, root: HTMLElement): Promise<void> {
  log.info(`booting ${req.config.model}`);
  const config = applyDipOverrides(req.config, req.port30, req.port31);

  const roms = loadRomsFromMap(config, req.roms, md5);
  const machine = new PC88Machine(config, roms);
  machine.reset();

  // First-light: run a short headless burst and dump the visible
  // text region. Once the panels land this is replaced by canvas
  // rendering + interactive control. Kept on the main thread for
  // now — the worker boundary is the next phase.
  const result = runMachine(machine, { maxOps: 200_000 });
  log.info(
    `stopped: ${result.reason} after ${result.ops} ops, PC=${result.finalPC.toString(16)}`,
  );

  root.innerHTML = "";
  const heading = document.createElement("h1");
  heading.textContent = `${config.model} — ${result.reason}`;
  root.appendChild(heading);

  const pre = document.createElement("pre");
  pre.className = "tvram-dump";
  pre.textContent = machine.display.toASCIIDump();
  root.appendChild(pre);

  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back to boot screen";
  back.addEventListener("click", () => {
    void main();
  });
  root.appendChild(back);
}

// Apply DIP overrides without mutating the variant config. The
// PC88Config interface is `readonly` end-to-end, so we shallow-clone
// and replace `dipSwitches`.
function applyDipOverrides(
  base: PC88Config,
  port30: number,
  port31: number,
): PC88Config {
  return { ...base, dipSwitches: { port30, port31 } };
}

void main();
