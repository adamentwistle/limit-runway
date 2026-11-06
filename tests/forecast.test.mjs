import assert from "node:assert/strict";
import test from "node:test";
import { burnRate, currentWindow, forecast, neededCoverageMinutes, neededSpanMinutes, staleAfterMinutes } from "../src/forecast.js";
import { duration, forecastText, when } from "../src/format.js";

const MIN = 60000, NOW = Date.UTC(2026, 10, 6, 12);
const iso = (ms) => new Date(ms).toISOString();
const line = (from, perHour, spanMin, stepMin, resetAt) => {
  const rows = [];
  for (let m = spanMin; m >= 0; m -= stepMin) rows.push({ t: NOW - m * MIN, used: from + (perHour * (spanMin - m)) / 60, resetAt });
  return rows;
};
const limitOf = (rows, resetAt, windowMinutes = 300) => ({ used: rows.at(-1).used, resetAt, windowMinutes, at: rows.at(-1).t });

test("a steady burn forecasts when it hits 100% and how long before the reset", () => {
  const resetAt = iso(NOW + 240 * MIN);
  const rows = line(40, 20, 60, 5, resetAt); // 60% now, at 20% an hour: two hours left
  const f = forecast(limitOf(rows, resetAt), rows, NOW);
  assert.equal(f.state, "hits");
  assert.equal(f.burnPerHour, 20);
  assert.equal(f.hitsAt, iso(NOW + 120 * MIN));
  assert.equal(f.marginMs, 120 * MIN);
  assert.equal(f.confidence, "good");
});

test("a slow burn is safe until reset", () => {
  const resetAt = iso(NOW + 60 * MIN);
  const rows = line(40, 6, 60, 5, resetAt);
  assert.equal(forecast(limitOf(rows, resetAt), rows, NOW).state, "safe");
});

test("no burn at all is safe, and says so with a zero rate", () => {
  const resetAt = iso(NOW + 60 * MIN);
  const rows = line(40, 0, 60, 5, resetAt);
  const f = forecast(limitOf(rows, resetAt), rows, NOW);
  assert.equal(f.state, "safe");
  assert.equal(f.burnPerHour, 0);
});

test("too few samples gives no forecast and says what it has", () => {
  const resetAt = iso(NOW + 60 * MIN);
  const two = line(40, 60, 5, 5, resetAt);
  const f = forecast(limitOf(two, resetAt), two, NOW);
  assert.equal(f.state, "few-samples");
  assert.equal(f.hitsAt, null);
  assert.equal(f.burnPerHour, null);
  assert.equal(f.samples, 2);
  assert.equal(forecastText({ forecast: f, resetAt }, NOW), "too few samples: 2 over 5m, needs 3 over 15m");
});

test("many samples over too short a time are still too few", () => {
  const resetAt = iso(NOW + 60 * MIN);
  const rows = line(40, 60, 6, 1, resetAt);
  assert.equal(forecast(limitOf(rows, resetAt), rows, NOW).state, "few-samples");
});

test("a weekly limit needs 15% of its window behind it", () => {
  assert.equal(neededSpanMinutes(300), 10);
  assert.equal(neededSpanMinutes(10080), 60);
  assert.equal(neededCoverageMinutes(300), 15);
  assert.equal(neededCoverageMinutes(10080), 1512);
  const rows = line(10, 2, 30, 5, iso(NOW + 6.5 * 1440 * MIN));
  assert.equal(forecast(limitOf(rows, rows[0].resetAt, 10080), rows, NOW).state, "few-samples");
  const later = line(10, 2, 30, 5, iso(NOW + 3 * 1440 * MIN));
  assert.equal(forecast(limitOf(later, later[0].resetAt, 10080), later, NOW).state, "safe");
});

// A short burst of Codex at the start of a working day, then nothing.
const burst = (agoMinutes, resetAt) => [0, 6, 12, 18].map((m, i) => ({ t: NOW - (agoMinutes + 18 - m) * MIN, used: 5.8 + i * 1.4, resetAt }));

test("Codex weekly at 10% after an 8 hour old burst has no forecast, and says why", () => {
  const resetAt = iso(NOW + 5 * 1440 * MIN), rows = burst(480, resetAt);
  const limit = { label: "Codex weekly", used: 10, resetAt, windowMinutes: 10080, at: rows.at(-1).t };
  const f = forecast(limit, rows, NOW);
  assert.equal(f.state, "stale");
  assert.equal(f.hitsAt, null);
  assert.equal(f.burnPerHour, null);
  assert.equal(f.ageMinutes, 480);
  assert.match(forecastText({ ...limit, forecast: f }, NOW), /^no reading for 8h/);
});

test("the same burst read just now is held to the window's pace, and isn't a risk", () => {
  const resetAt = iso(NOW + 5 * 1440 * MIN), rows = burst(0, resetAt);
  const f = forecast({ used: 10, resetAt, windowMinutes: 10080, at: NOW }, rows, NOW);
  assert.equal(f.state, "safe");
  assert.equal(f.basis, "pace");
  assert.ok(f.burnPerHour < 0.3, String(f.burnPerHour));
});

test("a weekly limit's forecast comes from its pace, so working hours aren't run round the clock", () => {
  const resetAt = iso(NOW + 2 * 1440 * MIN), rows = line(60, 6, 180, 10, resetAt); // 78% after 5 days, 6% an hour today
  const f = forecast({ used: 78, resetAt, windowMinutes: 10080, at: NOW }, rows, NOW);
  assert.equal(f.basis, "pace");
  assert.equal(f.burnPerHour, 0.65);
  assert.equal(f.state, "hits"); // 34 hours to 100% at this pace, not the 3 and a half hours today's rate would say
  assert.ok(Math.abs(Date.parse(f.hitsAt) - (NOW + (22 / 0.65) * 3600000)) < 20 * MIN);
});

test("a short window's reading goes stale in 20 minutes, and a long one's in hours", () => {
  assert.equal(staleAfterMinutes(300), 20);
  assert.equal(staleAfterMinutes(10080), 210);
  const resetAt = iso(NOW + 120 * MIN), rows = line(40, 20, 60, 5, resetAt).map((row) => ({ ...row, t: row.t - 25 * MIN }));
  assert.equal(forecast({ ...limitOf(rows, resetAt) }, rows, NOW).state, "stale");
});

test("at 100% a limit stays at the limit however old the reading", () => {
  const resetAt = iso(NOW + 120 * MIN), rows = line(90, 10, 60, 5, resetAt).map((row) => ({ ...row, t: row.t - 90 * MIN }));
  assert.equal(forecast({ used: 100, resetAt, windowMinutes: 300, at: NOW - 90 * MIN }, rows, NOW).state, "at-limit");
});

test("with under an hour of history a short window leans on its pace, not the burst", () => {
  const resetAt = iso(NOW + 200 * MIN), rows = line(4, 80, 15, 3, resetAt); // 24% in 100 minutes, with 80% an hour in the last 15
  const f = forecast({ used: 24, resetAt, windowMinutes: 300, at: NOW }, rows, NOW);
  assert.ok(f.burnPerHour > 14.4 && f.burnPerHour < 40, String(f.burnPerHour));
});

test("just enough samples gives a forecast marked low confidence", () => {
  const resetAt = iso(NOW + 240 * MIN);
  const rows = line(40, 30, 15, 5, resetAt);
  const f = forecast(limitOf(rows, resetAt), rows, NOW);
  assert.equal(f.state, "hits");
  assert.equal(f.confidence, "low");
  assert.match(forecastText({ forecast: f, resetAt }, NOW), /\(rough\)$/);
});

test("samples from before a reset are left out", () => {
  const resetAt = iso(NOW + 240 * MIN), oldReset = iso(NOW - 60 * MIN);
  const old = line(80, 20, 120, 10, oldReset).map((row) => ({ ...row, t: row.t - 90 * MIN }));
  const fresh = line(2, 6, 30, 10, resetAt);
  const rows = [...old, ...fresh];
  assert.equal(currentWindow(rows).length, fresh.length);
  const f = forecast(limitOf(fresh, resetAt), rows, NOW);
  assert.equal(f.samples, 4);
  assert.equal(f.state, "safe");
});

test("usage that falls starts a new window even if the reset time didn't move", () => {
  const resetAt = iso(NOW + 100 * MIN);
  const rows = [{ t: NOW - 30 * MIN, used: 90, resetAt }, { t: NOW - 20 * MIN, used: 5, resetAt }, { t: NOW - 10 * MIN, used: 6, resetAt }];
  assert.deepEqual(currentWindow(rows).map((r) => r.used), [5, 6]);
});

test("a reset time that wobbles by seconds stays one window", () => {
  const rows = [0, 1, 2].map((i) => ({ t: NOW - (3 - i) * 5 * MIN, used: 10 + i, resetAt: iso(NOW + 100 * MIN + i * 1000) }));
  assert.equal(currentWindow(rows).length, 3);
});

test("the rate comes from the recent stretch, not the whole window", () => {
  const resetAt = iso(NOW + 200 * MIN);
  const quiet = line(10, 0, 120, 10, resetAt).map((row) => ({ ...row, t: row.t - 60 * MIN }));
  const busy = line(10, 40, 60, 5, resetAt);
  const f = forecast(limitOf(busy, resetAt), [...quiet, ...busy], NOW);
  assert.equal(Math.round(f.burnPerHour), 40);
});

test("a reset in the past and a missing reset are named, with no forecast", () => {
  const rows = line(40, 20, 60, 5, iso(NOW - MIN));
  assert.equal(forecast(limitOf(rows, iso(NOW - MIN)), rows, NOW).state, "reset-passed");
  assert.equal(forecast(limitOf(rows, null), rows, NOW).state, "no-reset");
});

test("at 100% it says so", () => {
  const resetAt = iso(NOW + 30 * MIN);
  const rows = [{ t: NOW, used: 100, resetAt }];
  assert.equal(forecast(limitOf(rows, resetAt), rows, NOW).state, "at-limit");
});

test("burnRate needs two points in time", () => {
  assert.equal(burnRate([{ t: 0, used: 1 }]), null);
  assert.equal(burnRate([{ t: 5, used: 1 }, { t: 5, used: 2 }]), null);
  assert.equal(burnRate([{ t: 0, used: 10 }, { t: 3600000, used: 5 }]), 0);
});

test("durations and times read the way the brief says", () => {
  assert.equal(duration(130 * MIN), "2h 10m");
  assert.equal(duration(45 * MIN), "45m");
  assert.equal(duration(120 * MIN), "2h");
  assert.equal(duration(3 * 1440 * MIN + 5 * 60 * MIN), "3d 5h");
  const noon = new Date(2026, 10, 6, 12, 0).getTime();
  assert.equal(when(new Date(2026, 10, 6, 14, 20).getTime(), noon), "14:20");
  assert.match(when(new Date(2026, 10, 7, 9, 5).getTime(), noon), /^Sat 09:05$/);
  const f = { state: "hits", hitsAt: new Date(new Date(2026, 10, 6, 14, 20).getTime()).toISOString(), marginMs: 130 * MIN, confidence: "good", burnPerHour: 10 };
  assert.equal(forecastText({ forecast: f, resetAt: iso(noon + 500 * MIN) }, noon), "hits 100% at 14:20, 2h 10m before reset");
});
