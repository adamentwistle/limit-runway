// Codex writes its rate limits into its session files, in `token_count` events. Checked against real files from Codex CLI
// 0.163 on a Plus plan, which held one weekly `primary` window with `resets_at` in epoch seconds and a null `secondary`.
// Older files gave `resets_in_seconds` instead, and other plans a 5-hour window too. Those two come from Codex's published
// format and haven't been seen here.
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { percent } from "./usage-answer.js";

const TAIL = 1 << 20;
const MOST_FILES = 8;

export const codexDir = (env = process.env) => env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".codex");

const list = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// The newest session files. They sit in sessions/YYYY/MM/DD, so the folders are walked newest first and the walk stops early.
export function newestSessions(root, most = MOST_FILES) {
  const found = [];
  const byName = (a, b) => b.name.localeCompare(a.name);
  for (const year of list(join(root, "sessions")).filter((e) => e.isDirectory()).sort(byName)) {
    for (const month of list(join(root, "sessions", year.name)).filter((e) => e.isDirectory()).sort(byName)) {
      for (const day of list(join(root, "sessions", year.name, month.name)).filter((e) => e.isDirectory()).sort(byName)) {
        const folder = join(root, "sessions", year.name, month.name, day.name);
        for (const entry of list(folder)) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(join(folder, entry.name));
        }
        if (found.length >= most) break;
      }
      if (found.length >= most) break;
    }
    if (found.length >= most) break;
  }
  const dated = found.map((path) => {
    try {
      return { path, mtime: statSync(path).mtimeMs };
    } catch {
      return { path, mtime: 0 };
    }
  });
  return dated.sort((a, b) => b.mtime - a.mtime).slice(0, most).map((f) => f.path);
}

// The end of a file only: these reach tens of megabytes.
function tail(path, bytes = TAIL) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size, length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const windowName = (minutes) => {
  if (minutes === 10080) return "weekly";
  if (minutes === 300) return "5-hour";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
};

// One window of a rate_limits record, as a limit.
export function windowLimit(record, at, group) {
  const used = percent(record?.used_percent);
  const minutes = Number(record?.window_minutes);
  if (used === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  let resetMs = NaN;
  if (typeof record.resets_at === "number") resetMs = record.resets_at * 1000;
  else if (typeof record.resets_in_seconds === "number") resetMs = at + record.resets_in_seconds * 1000;
  const name = windowName(minutes);
  const extra = group && group !== "codex" ? `.${String(group).replace(/[^a-z0-9_-]/gi, "")}` : "";
  return {
    id: `codex.${name}${extra}`,
    provider: "codex",
    label: `Codex ${name}${extra ? ` ${String(group)}` : ""}`,
    windowMinutes: minutes,
    used,
    resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString().replace(/\.\d+Z$/, "Z") : null,
    at,
    source: "codex",
  };
}

// Every reading in some session text, oldest first. Only lines that mention rate_limits are parsed.
export function readingsFrom(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = row?.payload?.rate_limits;
    const at = Date.parse(row?.timestamp);
    if (!limits || !Number.isFinite(at)) continue;
    for (const key of ["primary", "secondary"]) {
      const limit = windowLimit(limits[key], at, limits.limit_id);
      if (limit) out.push(limit);
    }
  }
  return out;
}

// { at, limits, history } or null. `history` is every older reading kept in the files, which gives the forecast something
// to go on from the first run.
export function readCodex({ env = process.env } = {}) {
  const readings = [];
  for (const path of newestSessions(codexDir(env))) readings.push(...readingsFrom(tail(path)));
  if (!readings.length) return null;
  readings.sort((a, b) => a.at - b.at);
  const latest = new Map();
  for (const reading of readings) latest.set(reading.id, reading);
  const limits = [...latest.values()];
  return { source: "codex", at: Math.max(...limits.map((l) => l.at)), limits, history: readings };
}
