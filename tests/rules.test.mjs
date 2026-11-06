import assert from "node:assert/strict";
import test from "node:test";
import { withForecast } from "../src/sample.js";
import { decide, judge } from "../src/rules.js";

const MIN = 60000, NOW = Date.UTC(2026, 10, 6, 12);
const iso = (ms) => new Date(ms).toISOString();
const limit = (more = {}) => ({
  id: "claude.session", provider: "claude", label: "Claude 5-hour", used: 50, resetAt: iso(NOW + 120 * MIN), at: NOW,
  forecast: { state: "safe", confidence: "good" }, ...more,
});
const hits = (inMinutes, confidence = "good") => ({ state: "hits", confidence, hitsAt: iso(NOW + inMinutes * MIN) });

test("a calm limit does nothing", () => {
  assert.equal(decide({ limits: [limit()], pause: null, now: NOW }).action, "none");
});

test("usage past the threshold pauses until the reset and a minute", () => {
  const d = decide({ limits: [limit({ used: 95 })], pause: null, now: NOW });
  assert.equal(d.action, "pause");
  assert.equal(d.until, iso(NOW + 121 * MIN));
  assert.deepEqual(d.providers, ["claude"]);
  assert.match(d.reasons[0], /at 95%, past 95%/);
});

test("a forecast inside the lead time pauses", () => {
  assert.equal(decide({ limits: [limit({ used: 80, forecast: hits(20) })], pause: null, now: NOW }).action, "pause");
});

test("a forecast further off than the lead time waits", () => {
  assert.equal(judge(limit({ used: 80, forecast: hits(45) }), NOW).why, "hits-later");
});

test("a rough forecast never pauses", () => {
  assert.equal(judge(limit({ used: 80, forecast: hits(20, "low") }), NOW).fire, false);
});

test("a stale reading can't trigger a forecast pause, but a threshold still stands", () => {
  const old = NOW - 40 * MIN;
  assert.equal(judge(limit({ used: 80, at: old, forecast: hits(20) }), NOW).why, "stale");
  assert.equal(judge(limit({ used: 97, at: old }), NOW).fire, true);
});

test("a limit that resets within 15 minutes is left alone", () => {
  const soon = limit({ used: 99, resetAt: iso(NOW + 15 * MIN) });
  assert.equal(judge(soon, NOW).why, "resets-soon");
  assert.equal(decide({ limits: [soon], pause: null, now: NOW }).action, "none");
  assert.equal(judge(limit({ used: 99, resetAt: iso(NOW + 16 * MIN) }), NOW).fire, true);
});

test("the rules can be set, and per limit", () => {
  assert.equal(judge(limit({ used: 80 }), NOW, { pauseAt: 80 }).fire, true);
  assert.equal(judge(limit({ used: 80, forecast: hits(45) }), NOW, { forecastMinutes: 60 }).fire, true);
  assert.equal(judge(limit({ used: 99 }), NOW, { limits: { "claude.session": { ignore: true } } }).why, "ignored");
  assert.equal(judge(limit({ used: 90 }), NOW, { limits: { "claude.session": { pauseAt: 85 } } }).fire, true);
  assert.equal(judge(limit({ used: 99, resetAt: iso(NOW + 40 * MIN) }), NOW, { leaveAloneMinutes: 60 }).why, "resets-soon");
});

test("a pause runs to the furthest reset of everything calling for it", () => {
  const limits = [limit({ used: 96 }), limit({ id: "claude.weekly", used: 97, resetAt: iso(NOW + 2000 * MIN) })];
  assert.equal(decide({ limits, pause: null, now: NOW }).until, iso(NOW + 2001 * MIN));
});

test("while paused, a later limit extends the pause", () => {
  const pause = { by: "watch", providers: ["claude"], until: iso(NOW + 121 * MIN) };
  const limits = [limit({ used: 96 }), limit({ id: "claude.weekly", used: 97, resetAt: iso(NOW + 2000 * MIN) })];
  const d = decide({ limits, pause, now: NOW });
  assert.equal(d.action, "extend");
  assert.equal(d.until, iso(NOW + 2001 * MIN));
});

test("while paused, another plan's limit widens the pause", () => {
  const pause = { by: "watch", providers: ["claude"], until: iso(NOW + 500 * MIN) };
  const limits = [limit({ id: "codex.weekly", provider: "codex", used: 97 })];
  const d = decide({ limits, pause, now: NOW });
  assert.equal(d.action, "extend");
  assert.deepEqual(d.providers, ["claude", "codex"]);
  assert.equal(d.until, pause.until);
});

test("at the pause's end it resumes", () => {
  const pause = { by: "watch", providers: ["claude"], until: iso(NOW - MIN) };
  assert.equal(decide({ limits: [limit({ used: 2 })], pause, now: NOW }).action, "resume");
});

test("a pause with no end isn't resumed by watch, and a manual one isn't extended", () => {
  const pause = { by: "manual", providers: ["claude"], until: null };
  assert.equal(decide({ limits: [limit({ used: 96 })], pause, now: NOW }).action, "none");
});

test("a limit someone resumed past stays quiet for that window only", () => {
  const firing = limit({ used: 96 });
  const overrides = { "claude.session": firing.resetAt };
  assert.equal(decide({ limits: [firing], pause: null, now: NOW, overrides }).action, "none");
  const next = limit({ used: 96, resetAt: iso(NOW + 400 * MIN) });
  assert.equal(decide({ limits: [next], pause: null, now: NOW, overrides }).action, "pause");
});

test("watch won't pause on a burst: the same forecast that keeps it off the panel keeps it from acting", () => {
  const resetAt = new Date(NOW + 5 * 1440 * MIN).toISOString();
  const rows = [0, 6, 12, 18].map((m, i) => ({ t: NOW - (480 + 18 - m) * MIN, used: 5.8 + i * 1.4, resetAt }));
  const stale = { id: "codex.weekly", provider: "codex", label: "Codex weekly", used: 10, resetAt, windowMinutes: 10080, at: rows.at(-1).t };
  const fresh = { ...stale, at: NOW };
  for (const limit of [stale, fresh]) {
    const read = withForecast(limit, rows.map((row) => ({ ...row, id: limit.id, t: limit === fresh ? row.t + 480 * MIN : row.t })), NOW);
    assert.equal(decide({ limits: [read], pause: null, now: NOW }).action, "none");
  }
});
