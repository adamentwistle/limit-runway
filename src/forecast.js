// The forecast. Pure: samples in, an answer out. Percentages come in whole numbers from most sources and usage arrives in
// bursts, so the answer always says how much it's resting on.
const MINUTE = 60000;
const HOUR = 60 * MINUTE;

export const DEFAULT_FORECAST = { minSamples: 3, minSpanMinutes: 10 };

// Enough span to see past a percentage step: 10 minutes for a 5-hour limit, an hour for a weekly one.
export const neededSpanMinutes = (windowMinutes, base = DEFAULT_FORECAST.minSpanMinutes) => Math.max(base, Math.round((windowMinutes ?? 300) / 168));

// The recent stretch the rate is taken from: an hour of a 5-hour limit, a day of a weekly one.
export const lookbackMinutes = (windowMinutes) => Math.max(60, Math.round((windowMinutes ?? 300) / 7));

// A window this long is used in working hours, not round the clock, so its latest burst says little about the rest of it.
const PACE_FROM_MINUTES = 1440;
export const usesPace = (windowMinutes) => (windowMinutes ?? 300) >= PACE_FROM_MINUTES;

// How old the newest reading can be before there's no forecast: 20 minutes of a 5-hour limit, three and a half hours of a week.
export const staleAfterMinutes = (windowMinutes) => Math.max(20, Math.round((windowMinutes ?? 300) / 48));

// How much of the window a forecast has to rest on. Samples of a short window, elapsed time of a long one.
export const neededCoverageMinutes = (windowMinutes) => Math.round((windowMinutes ?? 300) * (usesPace(windowMinutes) ? 0.15 : 0.05));

// Usage so far over the time since the window began, in percent an hour.
export const paceOf = (used, elapsedMinutes) => (elapsedMinutes > 0 ? (used / elapsedMinutes) * 60 : 0);

// The samples that belong to the same window as the newest one. A reset that moves, or a usage that falls, is a new window.
export function currentWindow(samples) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const kept = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const sample = sorted[i], newer = kept[0];
    if (newer) {
      const moved = newer.resetAt && sample.resetAt && Math.abs(Date.parse(newer.resetAt) - Date.parse(sample.resetAt)) > 10 * MINUTE;
      if (moved || sample.used > newer.used + 0.5) break;
    }
    kept.unshift(sample);
  }
  return kept;
}

// Least squares over the stretch, in percent an hour, never below zero: usage inside a window only goes up.
export function burnRate(samples) {
  if (samples.length < 2) return null;
  const t0 = samples[0].t, n = samples.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = (s.t - t0) / HOUR;
    sx += x; sy += s.used; sxx += x * x; sxy += x * s.used;
  }
  const bottom = n * sxx - sx * sx;
  if (bottom <= 0) return null;
  return Math.max(0, (n * sxy - sx * sy) / bottom);
}

/**
 * @param limit { used, resetAt (ISO or null), windowMinutes, at (ms of the newest reading) }
 * @param samples every stored sample for this limit
 * @returns { state, basis, burnPerHour, hitsAt, marginMs, samples, spanMinutes, neededSamples, neededSpanMinutes, ageMinutes, confidence }
 *   state: "no-reset"     no reset time, so nothing can be said
 *          "reset-passed" the reading is from a window that has ended
 *          "at-limit"     already at 100%
 *          "stale"        the newest reading is too old for its window
 *          "few-samples"  too little of the window to go on
 *          "hits"         at this rate it reaches 100% before the reset
 *          "safe"         at this rate it doesn't
 */
export function forecast(limit, samples, now, options = {}) {
  const minSamples = options.minSamples ?? DEFAULT_FORECAST.minSamples;
  const pace = usesPace(limit.windowMinutes);
  const needSpan = Math.max(neededSpanMinutes(limit.windowMinutes, options.minSpanMinutes), neededCoverageMinutes(limit.windowMinutes));
  const resetMs = limit.resetAt ? Date.parse(limit.resetAt) : NaN;
  const window = currentWindow(samples);
  const newest = Math.max(window.at(-1)?.t ?? 0, limit.at ?? 0) || now;
  const ageMinutes = Math.max(0, Math.round((now - newest) / MINUTE));
  const elapsedMinutes = Number.isFinite(resetMs) ? (now - (resetMs - (limit.windowMinutes ?? 300) * MINUTE)) / MINUTE : 0;
  const spanMinutes = pace ? elapsedMinutes : window.length > 1 ? (window.at(-1).t - window[0].t) / MINUTE : 0;
  const base = { basis: pace ? "pace" : "recent", burnPerHour: null, hitsAt: null, marginMs: null, samples: window.length, spanMinutes: Math.round(spanMinutes), neededSamples: minSamples, neededSpanMinutes: needSpan, ageMinutes, confidence: "none" };

  if (!Number.isFinite(resetMs)) return { ...base, state: "no-reset" };
  if (resetMs <= now) return { ...base, state: "reset-passed" };
  if (limit.used >= 100) return { ...base, state: "at-limit", hitsAt: new Date(limit.at ?? now).toISOString(), marginMs: resetMs - (limit.at ?? now), confidence: "high" };
  if (ageMinutes > staleAfterMinutes(limit.windowMinutes)) return { ...base, state: "stale" };
  if (window.length < minSamples || spanMinutes < needSpan) return { ...base, state: "few-samples" };

  const { burnPerHour, confidence } = pace ? paceRate(limit, elapsedMinutes, needSpan) : recentRate(limit, window, elapsedMinutes, minSamples, needSpan);
  const known = { ...base, burnPerHour: round(burnPerHour), confidence };
  if (burnPerHour <= 0) return { ...known, state: "safe" };

  const lastAt = pace ? newest : window.at(-1).t;
  const lastUsed = pace ? limit.used : window.at(-1).used;
  const hitsMs = lastAt + ((100 - lastUsed) / burnPerHour) * HOUR;
  if (hitsMs >= resetMs) return { ...known, state: "safe" };
  return { ...known, state: "hits", hitsAt: new Date(hitsMs).toISOString(), marginMs: resetMs - hitsMs };
}

// A long window: the pace of the window so far, nights and weekends included, so a burst can't be run round the clock.
const paceRate = (limit, elapsedMinutes, needSpan) => ({ burnPerHour: paceOf(limit.used, elapsedMinutes), confidence: elapsedMinutes >= 2 * needSpan ? "good" : "low" });

// A short window: the last hour's rate. With less than an hour of history it leans on the window's pace, so a burst in the
// first minutes isn't taken for the rate.
function recentRate(limit, window, elapsedMinutes, minSamples, needSpan) {
  const lookback = lookbackMinutes(limit.windowMinutes);
  const since = window.at(-1).t - lookback * MINUTE;
  let recent = window.filter((s) => s.t >= since);
  if (recent.length < minSamples) recent = window.slice(-minSamples);
  const recentSpan = (recent.at(-1).t - recent[0].t) / MINUTE;
  const weight = Math.min(1, recentSpan / lookback);
  const burnPerHour = (burnRate(recent) ?? 0) * weight + paceOf(limit.used, elapsedMinutes) * (1 - weight);
  return { burnPerHour, confidence: recent.length >= 6 && recentSpan >= 3 * needSpan ? "good" : "low" };
}

const round = (value) => Math.round(value * 100) / 100;
