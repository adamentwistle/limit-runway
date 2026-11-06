// `runway watch`: one tick is a reading, a decision, and with --act the deed. Without --act it only says what it would do.
import { closeSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pauseNow, resumeNow } from "./actions.js";
import { files, readJson } from "./paths.js";
import { readOverrides, readPause, writePause } from "./pause.js";
import { decide } from "./rules.js";
import { collect } from "./sample.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// How many tool calls the hook is holding now. A note left by a hook that was killed doesn't count, and goes.
export function heldCount(paths = files()) {
  let names;
  try {
    names = readdirSync(paths.held);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    const path = join(paths.held, name);
    const note = readJson(path);
    if (note && alive(note.pid)) count += 1;
    else rmSync(path, { force: true });
  }
  return count;
}

// One acting watcher at a time.
export function takeLock(paths = files()) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(paths.watchLock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(paths.watchLock, "utf8"));
      if (pid && alive(pid)) return false;
      rmSync(paths.watchLock, { force: true });
    }
  }
  return false;
}

export const releaseLock = (paths = files()) => rmSync(paths.watchLock, { force: true });

export function watcherRunning(paths = files()) {
  try {
    const pid = Number(readFileSync(paths.watchLock, "utf8"));
    return Boolean(pid && alive(pid));
  } catch {
    return false;
  }
}

/**
 * @param options { act, herdr, machines, onPause, onResume, config, env, paths, now, endpoint }
 * @returns { reading, decision, did }  did: null, or "paused", "extended", "resumed"
 */
export async function tick(options) {
  const { act = false, herdr = false, machines, onPause, onResume, config, env = process.env, paths = files(), now = Date.now(), endpoint } = options;
  const reading = await collect({ paths, config, env, now, endpoint });
  const pause = readPause(paths);
  const decision = decide({ limits: reading.limits, pause: pause?.broken ? null : pause, now, config, overrides: readOverrides(paths) });
  if (!act) return { reading, decision, did: null, wouldDo: decision.action === "none" ? null : decision.action };

  if (decision.action === "pause") {
    const resets = Object.fromEntries(reading.limits.filter((l) => decision.limits.includes(l.id)).map((l) => [l.id, l.resetAt]));
    const report = await pauseNow(
      { by: "watch", reason: decision.reasons.join(". "), providers: decision.providers, until: decision.until, limits: decision.limits, resets, onResume: onResume ?? config.onResume },
      { herdr, machines, onPause: onPause ?? config.onPause, config, env, paths, now },
    );
    return { reading, decision, did: "paused", report };
  }
  if (decision.action === "extend") {
    const resets = Object.fromEntries(reading.limits.filter((l) => decision.limits.includes(l.id)).map((l) => [l.id, l.resetAt]));
    writePause({ ...pause, until: decision.until, providers: decision.providers, reason: decision.reasons.join(". "), limits: decision.limits, resets: { ...(pause.resets ?? {}), ...resets } }, paths);
    return { reading, decision, did: "extended" };
  }
  if (decision.action === "resume") {
    const report = await resumeNow({ manual: false, config, env, paths, onResume: onResume ?? config.onResume });
    return { reading, decision, did: "resumed", report };
  }
  return { reading, decision, did: null };
}
