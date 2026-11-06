// The pause file. If it exists, runway is paused. Everything else, the hook included, follows from that one file, so
// deleting it by hand is as good as `runway resume`.
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { ensureDir, files, readJson, writeJsonAtomic } from "./paths.js";

export const PROVIDERS = ["claude", "codex"];

export function readPause(paths = files()) {
  if (!existsSync(paths.pause)) return null;
  let text;
  try {
    text = readFileSync(paths.pause, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? null : { broken: true };
  }
  try {
    const pause = JSON.parse(text);
    return pause && typeof pause === "object" ? pause : { broken: true };
  } catch {
    return { broken: true };
  }
}

export function writePause(pause, paths = files()) {
  ensureDir(paths.dir);
  writeJsonAtomic(paths.pause, pause);
  return pause;
}

// Takes the pause file away. Whoever wins the rename does the resuming, so a watcher and a panel can't both send the
// resume line. A file that can't be renamed is deleted, because a release must never fail.
export function claimPause(paths = files()) {
  if (!existsSync(paths.pause)) return null;
  const pause = readPause(paths);
  const claimed = `${paths.pause}.${process.pid}.claimed`;
  try {
    renameSync(paths.pause, claimed);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    rmSync(paths.pause, { force: true });
    return pause;
  }
  rmSync(claimed, { force: true });
  return pause;
}

export const untilMs = (pause) => {
  const ms = pause?.until ? Date.parse(pause.until) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

export const covers = (pause, provider) => {
  if (!pause) return false;
  if (!Array.isArray(pause.providers)) return true;
  return pause.providers.includes(provider);
};

export const pauseOver = (pause, now) => {
  const until = untilMs(pause);
  return until !== null && now >= until;
};

export const readOverrides = (paths = files()) => readJson(paths.overrides) ?? {};
