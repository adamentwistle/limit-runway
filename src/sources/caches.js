// The usage files other tools already keep. Reading one costs no request and needs no login, so they come first.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { limitsFromKeys } from "./usage-answer.js";

const LARGEST = 1 << 20;

export const cachePaths = (env = process.env) => {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [
    { source: "orchi", path: join(home, ".cache", "orchi", "usage.json") },
    { source: "ccstatusline", path: join(home, ".cache", "ccstatusline", "usage.json") },
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
