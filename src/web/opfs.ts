import type { MD5Sum, ROMID } from "../flavours.js";

// OPFS-backed ROM store + settings persistence. ROMs are
// content-addressed by md5 (`/roms/<md5>.rom`); the per-variant index
// (`/index.json`) maps `ROMID` → md5 for the user's loaded set, so
// switching variants reuses any ROMs that md5-match between them.
//
// Falls back to in-memory storage when navigator.storage.getDirectory
// is unavailable (private mode in some browsers, or contexts without
// the `Storage` permission). The fallback satisfies the same
// interface — settings + ROMs survive within a session, but not
// across reloads.

export interface OpfsStore {
  readRom: (md5: MD5Sum) => Promise<Uint8Array | null>;
  writeRom: (md5: MD5Sum, bytes: Uint8Array) => Promise<void>;
  listRoms: () => Promise<MD5Sum[]>;
  readJSON: <T>(name: string) => Promise<T | null>;
  writeJSON: <T>(name: string, value: T) => Promise<void>;
  // Surface for the boot screen so the user can see if persistence
  // is real or in-memory only.
  readonly persistent: boolean;
}

interface RootDir {
  getDirectoryHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<RootDir>;
  getFileHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<{
    getFile: () => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>;
    createWritable: () => Promise<{
      write: (data: BufferSource | string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
  removeEntry: (name: string) => Promise<void>;
  values: () => AsyncIterable<{ kind: "file" | "directory"; name: string }>;
}

async function tryOpenOpfs(): Promise<RootDir | null> {
  const storage = (
    globalThis as {
      navigator?: { storage?: { getDirectory?: () => Promise<RootDir> } };
    }
  ).navigator?.storage;
  if (!storage?.getDirectory) return null;
  try {
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

class InMemoryStore implements OpfsStore {
  readonly persistent = false;
  private readonly roms = new Map<MD5Sum, Uint8Array>();
  private readonly json = new Map<string, unknown>();
  async readRom(md5: MD5Sum) {
    return this.roms.get(md5) ?? null;
  }
  async writeRom(md5: MD5Sum, bytes: Uint8Array) {
    this.roms.set(md5, bytes);
  }
  async listRoms() {
    return [...this.roms.keys()];
  }
  async readJSON<T>(name: string) {
    return (this.json.get(name) as T) ?? null;
  }
  async writeJSON<T>(name: string, value: T) {
    this.json.set(name, value);
  }
}

class OpfsBackedStore implements OpfsStore {
  readonly persistent = true;
  constructor(private readonly root: RootDir) {}

  private async romsDir(): Promise<RootDir> {
    return this.root.getDirectoryHandle("roms", { create: true });
  }

  async readRom(md5: MD5Sum) {
    try {
      const dir = await this.romsDir();
      const fh = await dir.getFileHandle(`${md5}.rom`);
      const file = await fh.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async writeRom(md5: MD5Sum, bytes: Uint8Array) {
    const dir = await this.romsDir();
    const fh = await dir.getFileHandle(`${md5}.rom`, { create: true });
    const w = await fh.createWritable();
    // Copy into a fresh ArrayBuffer; some implementations refuse the
    // backing buffer of a Uint8Array view directly, and the view
    // could be backed by a SharedArrayBuffer the writer doesn't
    // accept either.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await w.write(copy.buffer);
    await w.close();
  }

  async listRoms() {
    const dir = await this.romsDir();
    const out: MD5Sum[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file" && entry.name.endsWith(".rom")) {
        out.push(entry.name.slice(0, -4) as MD5Sum);
      }
    }
    return out;
  }

  async readJSON<T>(name: string) {
    try {
      const fh = await this.root.getFileHandle(`${name}.json`);
      const file = await fh.getFile();
      const text = new TextDecoder().decode(await file.arrayBuffer());
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async writeJSON<T>(name: string, value: T) {
    const fh = await this.root.getFileHandle(`${name}.json`, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(value));
    await w.close();
  }
}

export async function openStore(): Promise<OpfsStore> {
  const root = await tryOpenOpfs();
  return root ? new OpfsBackedStore(root) : new InMemoryStore();
}

// Per-variant ROM index: ROMID → md5. The boot screen rebuilds it
// when the user adds or replaces a ROM; the next session reads it
// to pre-populate the checklist with the cached state.
export type RomIndex = Record<ROMID, MD5Sum>;

export interface BootSettings {
  variant?: string; // variantSlug
  basicOverride?: "n80" | "n88";
  port30Override?: number;
  port31Override?: number;
}
