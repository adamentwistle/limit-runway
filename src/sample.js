// Reads every source, keeps the samples and adds the forecast to each limit.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { currentWindow, forecast } from "./forecast.js";
import { appendLine, ensureDir, files } from "./paths.js";
import { cachePaths, readCache } from "./sources/caches.js";
import { readCodex } from "./sources/codex.js";
import { readEndpoint } from "./sources/endpoint.js";

const MINUTE = 60000;
const FRESH_MINUTES = 15;
const KEEP_DAYS = 8;
const LARGEST_HISTORY = 2 << 20;
const THIN_MS = 5 * MINUTE;
const SERIES_POINTS = 72;

export function readHistory(paths = files()) {
  if (!existsSync(paths.history)) return [];
  const rows = [];
  for (const line of readFileSync(paths.history, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row.id === "string" && Number.isFinite(row.t) && Number.isFinite(row.used)) rows.push(row);
    } catch {
      // A line cut short by a crash. The rest are fine.
    }
  }
  return rows;
}

// Adds readings not seen before. A reading is known by when it was taken, not when it was read, so a cache that hasn't
// changed adds nothing.
export function record(readings, paths = files(), now = Date.now()) {
  ensureDir(paths.dir);
  const rows = readHistory(paths);
  const last = new Map();
  const seen = new Set();
  for (const row of rows) {
    seen.add(`${row.id}@${row.t}`);
    last.set(row.id, Math.max(last.get(row.id) ?? 0, row.t));
  }
  const added = [];
  for (const reading of readings) {
    const key = `${reading.id}@${reading.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = { id: reading.id, t: reading.at, used: reading.used, resetAt: reading.resetAt ?? null, source: reading.source };
    appendLine(paths.history, row);
    added.push(row);
  }
  const all = [...rows, ...added];
  prune(paths, all, now);
  return all;
}

function prune(paths, rows, now) {
  try {
    if (statSync(paths.history).size < LARGEST_HISTORY) return;
  } catch {
    return;
  }
  const since = now - KEEP_DAYS * 24 * 60 * MINUTE;
  const kept = rows.filter((row) => row.t >= since).sort((a, b) => a.t - b.t);
  writeFileSync(paths.history, kept.map((row) => JSON.stringify(row)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
}

// Keeps one reading in each five minutes of a long history, and always the newest.
export function thin(readings) {
  const out = [];
  const lastAt = new Map();
  for (const reading of readings) {
    const previous = lastAt.get(reading.id);
    if (previous !== undefined && reading.at - previous < THIN_MS) continue;
    lastAt.set(reading.id, reading.at);
    out.push(reading);
  }
  return out;
}

// The points a chart draws: the current window's samples, the first in each even step of time, and always the newest, so a
// week of readings stays a small reply.
export function series(samples, most = SERIES_POINTS) {
  const window = currentWindow(samples).map(({ t, used }) => ({ t, used }));
  if (window.length <= most) return window;
  const from = window[0].t, step = (window.at(-1).t - from) / (most - 1), out = [];
  let last = -1;
  for (const sample of window) {
    const at = Math.floor((sample.t - from) / step);
    if (at !== last) out.push(sample);
    last = at;
  }
  if (out.at(-1) !== window.at(-1)) out[out.length - 1] = window.at(-1);
  return out;
}

export const LOGIN_NOTE = "No fresh usage cache. Run `runway login on` to read Claude's limits with your login";

// Claude's limits: a fresh cache if there is one, else the endpoint if the person agreed, else the newest cache however old.
export async function readClaude({ paths, config, env, now, endpoint = readEndpoint }) {
  const notes = [];
  const caches = cachePaths(env)
    .filter(({ source }) => config.sources[source] !== false)
    .map(readCache)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  const newest = caches[0] ?? null;
  if (newest && now - newest.at <= FRESH_MINUTES * MINUTE) return { reading: newest, notes };

  const undecided = config.sources.endpoint === null || config.sources.endpoint === undefined;
  if (undecided && !env.RUNWAY_NO_ENDPOINT) notes.push(LOGIN_NOTE);
  if (config.sources.endpoint === true && !env.RUNWAY_NO_ENDPOINT) {
    const reply = await endpoint({ paths, now, env });
    if (reply.status === "ok" && reply.limits.length) return { reading: { source: "endpoint", at: reply.at, limits: reply.limits }, notes };
    if (reply.status !== "waiting") notes.push(`Claude endpoint: ${reply.status}`);
  }
  return { reading: newest, notes };
}

/**
 * Every limit there is, with its forecast.
 * @returns { at, limits, sources: [{ source, ageMinutes }], notes }
 */
export async function collect({ paths = files(), config, env = process.env, now = Date.now(), endpoint } = {}) {
  const readings = [], sources = [];
  const { reading, notes } = await readClaude({ paths, config, env, now, endpoint });
  if (reading) {
    readings.push(...reading.limits);
    sources.push({ source: reading.source, ageMinutes: Math.round((now - reading.at) / MINUTE) });
  } else {
    notes.push("No Claude Code usage found");
  }
  let codexHistory = [], codexLimits = [];
  if (config.sources.codex !== false) {
    const codex = readCodex({ env });
    if (codex) {
      codexLimits = codex.limits;
      codexHistory = thin(codex.history);
      sources.push({ source: "codex", ageMinutes: Math.round((now - codex.at) / MINUTE) });
    }
  }
  const rows = record([...readings, ...codexHistory, ...codexLimits], paths, now);
  const limits = [...readings, ...codexLimits].map((limit) => withForecast(limit, rows, now, config));
  return { at: now, limits, sources, notes };
}

export function withForecast(limit, rows, now, config = {}) {
  const own = rows.filter((row) => row.id === limit.id);
  return {
    ...limit,
    samples: series(own),
    forecast: forecast(limit, own, now, { minSamples: config.minSamples, minSpanMinutes: config.minSpanMinutes }),
  };
}
