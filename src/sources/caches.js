// The usage files other tools already keep. Reading one costs no request and needs no login, so they come first.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { limitsFromKeys } from "./usage-answer.js";

const LARGEST = 1 << 20;

const PROFILE_FILE = /^usage-[0-9a-f]{16}\.json$/;
const modified = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
};

// ccstatusline 2.2.33 and later keep one file per Claude profile, usage-<first 16 hex of the sha256 of the config dir>.json,
// and no longer write usage.json. With CLAUDE_CONFIG_DIR set it's that profile's file. Without it, as when an app starts
// runway without the shell's settings, it's the newest of them. The old usage.json is read only when there is none.
export function ccstatuslinePath(env = process.env) {
  const folder = join(env.HOME || env.USERPROFILE || homedir(), ".cache", "ccstatusline");
  if (env.CLAUDE_CONFIG_DIR) {
    const own = join(folder, `usage-${createHash("sha256").update(env.CLAUDE_CONFIG_DIR).digest("hex").slice(0, 16)}.json`);
    if (modified(own) >= 0) return own;
  } else {
    let names = [];
    try {
      names = readdirSync(folder).filter((name) => PROFILE_FILE.test(name));
    } catch {
      // No folder: fall through to usage.json, which won't be there either.
    }
    const newest = names.map((name) => join(folder, name)).sort((a, b) => modified(b) - modified(a))[0];
    if (newest) return newest;
  }
  return join(folder, "usage.json");
}

export const cachePaths = (env = process.env) => {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [
    { source: "orchi", path: join(home, ".cache", "orchi", "usage.json") },
    { source: "ccstatusline", path: ccstatuslinePath(env) },
  ];
};

// When the numbers were read. It's the file's own `updatedAt` if it has one, else the file's time. Taking the clock instead
// would turn one old reading into a flat line of new ones, and the forecast would call a busy hour idle.
export function readCache({ source, path }) {
  let stats, keys;
  try {
    stats = statSync(path);
    if (!stats.isFile() || stats.size > LARGEST) return null;
    keys = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!keys || typeof keys !== "object") return null;
  const stated = typeof keys.updatedAt === "string" ? Date.parse(keys.updatedAt) : NaN;
  const at = Number.isFinite(stated) ? stated : stats.mtimeMs;
  const limits = limitsFromKeys(keys, { at: Math.round(at), source });
  return limits.length ? { source, at: Math.round(at), limits } : null;
}
