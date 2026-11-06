// Where runway keeps its state, and how it writes there. Nothing here is specific to any one file.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = (env = process.env) => env.RUNWAY_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".limit-runway");

export const files = (dir = stateDir()) => ({
  dir,
  config: join(dir, "config.json"),
  pause: join(dir, "pause.json"),
  history: join(dir, "history.jsonl"),
  endpoint: join(dir, "endpoint.json"),
  overrides: join(dir, "overrides.json"),
  held: join(dir, "held"),
  watchLock: join(dir, "watch.lock"),
  log: join(dir, "events.log"),
});

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Readers never see half a file: a temporary file in the same folder, then a rename. Windows refuses a rename over a
// file someone has open for a moment, so it tries again.
export function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (i >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
        rmSync(temp, { force: true });
        throw error;
      }
      sleepSync(25);
    }
  }
}

export function appendLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no such mode. The profile folder's own permissions cover it there.
  }
}
