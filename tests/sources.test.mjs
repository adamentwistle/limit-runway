import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS } from "../src/config.js";
import { LOGIN_NOTE, collect, readHistory, record, thin } from "../src/sample.js";
import { cachePaths, readCache } from "../src/sources/caches.js";
import { newestSessions, readCodex, readingsFrom, windowLimit } from "../src/sources/codex.js";
import { limitsFromKeys, parseAnswer, resetText } from "../src/sources/usage-answer.js";
import { minutes, sandbox } from "./helpers.mjs";

const config = (more = {}) => ({ ...DEFAULTS, ...more, sources: { ...DEFAULTS.sources, ...(more.sources ?? {}) } });

test("the endpoint's buckets become limits", () => {
  const keys = parseAnswer(JSON.stringify({ five_hour: { utilization: 29, resets_at: "2026-09-19T23:41:00.123+00:00" }, seven_day: { utilization: 40.5, resets_at: "2026-09-21T08:00:00Z" } }));
  assert.equal(keys.sessionUsage, 29);
  assert.equal(keys.sessionResetAt, "2026-09-19T23:41:00Z");
  assert.equal(keys.weeklyUsage, 40.5);
  const limits = limitsFromKeys(keys, { at: 1, source: "endpoint" });
  assert.deepEqual(limits.map((l) => l.id), ["claude.session", "claude.weekly"]);
  assert.equal(limits[0].windowMinutes, 300);
});

test("limits[] fills in, placeholders are skipped, and scoped models become their own limit", () => {
  const keys = parseAnswer(JSON.stringify({
    limits: [
      { kind: "session", percent: 0 },
      { kind: "session", percent: 12, resets_at: "2026-09-19T23:41:00Z" },
      { kind: "weekly_all", percent: 30, resets_at: "2026-09-21T08:00:00Z" },
      { kind: "weekly_scoped", percent: 9, resets_at: "2026-09-21T08:00:00Z", scope: { model: { display_name: "Fable" } } },
    ],
  }));
  assert.equal(keys.sessionUsage, 12);
  const limits = limitsFromKeys(keys, { at: 1, source: "endpoint" });
  assert.deepEqual(limits.map((l) => l.id), ["claude.session", "claude.weekly", "claude.weekly.fable"]);
});

test("five_hour null means no 5-hour limit", () => {
  const keys = parseAnswer(JSON.stringify({ five_hour: null, seven_day: { utilization: 10, resets_at: "2026-09-21T08:00:00Z" }, limits: [{ kind: "session", percent: 50, resets_at: "2026-09-19T23:41:00Z" }] }));
  assert.equal(keys.sessionUsage, 0);
  assert.equal(keys.sessionResetAt, undefined);
  assert.deepEqual(limitsFromKeys(keys, { at: 1, source: "x" }).map((l) => l.id), ["claude.weekly"]);
});

test("an answer with no session or weekly number is a changed endpoint", () => {
  for (const text of ["{}", "[]", "not json", JSON.stringify({ five_hour: null }), JSON.stringify({ five_hour: { utilization: 500 } })]) assert.equal(parseAnswer(text), null, text);
});

test("reset times must be real dates", () => {
  assert.equal(resetText("tomorrow"), null);
  assert.equal(resetText(12), null);
  assert.equal(resetText("2026-13-40T00:00:00Z"), null);
  assert.equal(resetText("2026-11-06T10:20:00.161609+00:00"), "2026-11-06T10:20:00Z");
});

test("ccstatusline's file is read, with the file's time as the reading's time", (t) => {
  const box = sandbox(t);
  box.cache("ccstatusline", { sessionUsage: 45, sessionResetAt: "2026-11-06T10:20:00.161609+00:00", weeklyUsage: 38, weeklyResetAt: "2026-11-11T21:00:00.161628+00:00", extraUsageEnabled: false, weeklySonnetUsage: 0, weeklyOpusUsage: 0, tokenHash: "made-up" });
  const entry = cachePaths(box.env)[1];
  const when = new Date(Date.UTC(2026, 10, 6, 8, 0));
  utimesSync(entry.path, when, when);
  const found = readCache(entry);
  assert.equal(found.at, when.getTime());
  assert.deepEqual(found.limits.map((l) => [l.id, l.used]), [["claude.session", 45], ["claude.weekly", 38]]);
});

// ccstatusline 2.2.33 and later write usage-<first 16 hex of sha256 of the config dir>.json, one per Claude profile.
const profileFile = (box, dir, value, when) => {
  const folder = join(box.home, ".cache", "ccstatusline");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `usage-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}.json`);
  writeFileSync(path, JSON.stringify(value));
  utimesSync(path, when, when);
  return path;
};

test("ccstatusline's per-profile file is read before the old usage.json", (t) => {
  const box = sandbox(t);
  box.cache("ccstatusline", { weeklyUsage: 94, weeklyResetAt: "2026-11-11T21:00:00Z" });
  const old = join(box.home, ".cache", "ccstatusline", "usage.json");
  utimesSync(old, new Date(Date.UTC(2026, 10, 4)), new Date(Date.UTC(2026, 10, 4)));
  const path = profileFile(box, box.env.CLAUDE_CONFIG_DIR, { weeklyUsage: 98, weeklyResetAt: "2026-11-09T04:00:00Z" }, new Date(Date.UTC(2026, 10, 7)));
  const entry = cachePaths(box.env)[1];
  assert.equal(entry.path, path);
  assert.deepEqual(readCache(entry).limits.map((l) => [l.id, l.used]), [["claude.weekly", 98]]);
});

test("with no profile set, the freshest per-profile file is read, and usage.json only when there is none", (t) => {
  const box = sandbox(t);
  const env = { ...box.env, CLAUDE_CONFIG_DIR: "" };
  box.cache("ccstatusline", { weeklyUsage: 94, weeklyResetAt: "2026-11-11T21:00:00Z" });
  assert.equal(cachePaths(env)[1].path, join(box.home, ".cache", "ccstatusline", "usage.json"));
  profileFile(box, join(box.home, ".claude"), { weeklyUsage: 10, weeklyResetAt: "2026-11-09T04:00:00Z" }, new Date(Date.UTC(2026, 10, 3)));
  const fresh = profileFile(box, join(box.home, ".claude-work"), { weeklyUsage: 98, weeklyResetAt: "2026-11-09T04:00:00Z" }, new Date(Date.UTC(2026, 10, 7)));
  writeFileSync(join(box.home, ".cache", "ccstatusline", "usage-0123456789abcdef.credentials.lock"), "{}");
  assert.equal(cachePaths(env)[1].path, fresh);
});

test("orchi's file says when it was read", (t) => {
  const box = sandbox(t);
  box.cache("orchi", { sessionUsage: 29, sessionResetAt: "2026-09-19T23:41:00+00:00", weeklyUsage: 40, weeklyResetAt: "2026-09-21T08:00:00+00:00", fableUsage: 9, fableResetAt: "2026-09-21T08:00:00+00:00", updatedAt: "2026-09-19T20:41:07Z" });
  const found = readCache(cachePaths(box.env)[0]);
  assert.equal(found.at, Date.parse("2026-09-19T20:41:07Z"));
  assert.ok(found.limits.some((l) => l.id === "claude.weekly.fable"));
});

test("a missing or broken cache is nothing", (t) => {
  const box = sandbox(t);
  assert.equal(readCache(cachePaths(box.env)[0]), null);
  mkdirSync(join(box.home, ".cache", "orchi"), { recursive: true });
  writeFileSync(join(box.home, ".cache", "orchi", "usage.json"), "{ nope");
  assert.equal(readCache(cachePaths(box.env)[0]), null);
});

const codexLine = (timestamp, used, resetsAt, extra = {}) => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "codex", limit_name: null, primary: { used_percent: used, window_minutes: 10080, resets_at: resetsAt }, secondary: null, credits: { has_credits: false, unlimited: false, balance: "0" }, plan_type: "plus", ...extra } } });

test("a Codex session line in the shape seen on a real Plus plan", () => {
  const [limit] = readingsFrom(codexLine("2026-11-01T18:10:48.157Z", 23, 1793793780));
  assert.equal(limit.id, "codex.weekly");
  assert.equal(limit.used, 23);
  assert.equal(limit.at, Date.parse("2026-11-01T18:10:48.157Z"));
  assert.equal(limit.resetAt, new Date(1793793780000).toISOString().replace(".000", ""));
});

test("Codex's older shape, with a 5-hour window and seconds to reset (unverified: from its published format)", () => {
  const at = Date.UTC(2026, 10, 6);
  const limit = windowLimit({ used_percent: 40, window_minutes: 300, resets_in_seconds: 3600 }, at, "codex");
  assert.equal(limit.id, "codex.5-hour");
  assert.equal(Date.parse(limit.resetAt), at + 3600000);
});

test("lines that aren't rate limits, or are broken, are skipped", () => {
  const text = ['{"type":"other"}', '{ "rate_limits": cut off', JSON.stringify({ timestamp: "x", payload: { rate_limits: {} } }), JSON.stringify({ timestamp: "2026-11-01T18:10:48Z", payload: { rate_limits: null } })].join("\n");
  assert.deepEqual(readingsFrom(text), []);
});

function codexFile(box, folder, name, lines) {
  const dir = join(box.env.CODEX_HOME, "sessions", ...folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("the newest session's last reading wins, and older ones become history", (t) => {
  const box = sandbox(t);
  const oldFile = codexFile(box, ["2026", "10", "31"], "rollout-a.jsonl", [codexLine("2026-10-31T10:00:00Z", 10, 1793793780)]);
  codexFile(box, ["2026", "11", "01"], "rollout-b.jsonl", [codexLine("2026-11-01T10:00:00Z", 20, 1793793780), codexLine("2026-11-01T11:00:00Z", 23, 1793793780)]);
  utimesSync(oldFile, new Date(0), new Date(0));
  const found = readCodex({ env: box.env });
  assert.equal(found.limits.length, 1);
  assert.equal(found.limits[0].used, 23);
  assert.equal(found.history.length, 3);
  assert.equal(newestSessions(box.env.CODEX_HOME)[0].endsWith("rollout-b.jsonl"), true);
});

test("no ~/.codex is nothing, not a failure", (t) => {
  assert.equal(readCodex({ env: sandbox(t).env }), null);
});

test("a cache that hasn't changed adds no sample, however often it's read", (t) => {
  const box = sandbox(t);
  const reading = { id: "claude.session", at: 1000, used: 5, resetAt: null, source: "x" };
  record([reading], box.paths, 2000);
  record([reading], box.paths, 3000);
  record([{ ...reading, at: 2000, used: 6 }], box.paths, 3000);
  assert.deepEqual(readHistory(box.paths).map((r) => r.used), [5, 6]);
});

test("a line cut short in the history doesn't lose the rest", (t) => {
  const box = sandbox(t);
  box.writeState("history.jsonl", `{"id":"a","t":1,"used":2}\n{"id":"a","t":\n{"id":"a","t":3,"used":4}\n`);
  assert.equal(readHistory(box.paths).length, 2);
});

test("a long history is thinned to one reading in five minutes", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: "a", at: i * minutes(1) }));
  assert.equal(thin(rows).length, 12);
});

test("a fresh cache means the endpoint isn't asked", async (t) => {
  const box = sandbox(t);
  box.cache("ccstatusline", { sessionUsage: 45, sessionResetAt: new Date(Date.now() + minutes(100)).toISOString(), weeklyUsage: 38, weeklyResetAt: new Date(Date.now() + minutes(9000)).toISOString() });
  let asked = 0;
  const reading = await collect({ paths: box.paths, config: config(), env: { ...box.env, RUNWAY_NO_ENDPOINT: "" }, endpoint: async () => { asked += 1; return { status: "offline" }; } });
  assert.equal(asked, 0);
  assert.equal(reading.limits[0].source, "ccstatusline");
});

test("a stale cache asks the endpoint, and is still used if the endpoint fails", async (t) => {
  const box = sandbox(t);
  box.cache("ccstatusline", { sessionUsage: 45, sessionResetAt: new Date(Date.now() + minutes(100)).toISOString() });
  const path = cachePaths(box.env)[1].path;
  const old = new Date(Date.now() - minutes(40));
  utimesSync(path, old, old);
  let asked = 0;
  const reading = await collect({ paths: box.paths, config: config({ sources: { endpoint: true } }), env: { ...box.env, RUNWAY_NO_ENDPOINT: "" }, endpoint: async () => { asked += 1; return { status: "offline" }; } });
  assert.equal(asked, 1);
  assert.equal(reading.limits[0].source, "ccstatusline");
  assert.deepEqual(reading.notes, ["Claude endpoint: offline"]);
});

test("the login isn't used until the person agrees, and the reading says how to", async (t) => {
  const box = sandbox(t);
  let asked = 0;
  const reading = await collect({ paths: box.paths, config: config(), env: { ...box.env, RUNWAY_NO_ENDPOINT: "" }, endpoint: async () => { asked += 1; return { status: "offline" }; } });
  assert.equal(asked, 0);
  assert.ok(reading.notes.includes(LOGIN_NOTE));
});

test("the endpoint can be turned off", async (t) => {
  const box = sandbox(t);
  let asked = 0;
  const endpoint = async () => { asked += 1; return { status: "offline" }; };
  await collect({ paths: box.paths, config: config({ sources: { endpoint: false } }), env: { ...box.env, RUNWAY_NO_ENDPOINT: "" }, endpoint });
  await collect({ paths: box.paths, config: config(), env: box.env, endpoint });
  assert.equal(asked, 0);
});

test("no data at all says so", async (t) => {
  const box = sandbox(t);
  const reading = await collect({ paths: box.paths, config: config(), env: box.env });
  assert.deepEqual(reading.limits, []);
  assert.deepEqual(reading.notes, ["No Claude Code usage found"]);
});
