// The panel's thinking, with no Herdr imports, so `node --test` can load it.
export const INSTALL_LINE = "npm install -g github:adamentwistle/limit-runway";

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Inside this long, a limit that's running out turns from `working` to `blocked`.
export const URGENT_MS = HOUR;

// Windows starts a program by its exact name, and npm's launcher there is runway.cmd.
export const commandNames = (windows) => (windows ? ["runway.cmd", "runway"] : ["runway"]);

export const statusArgs = () => ["status", "--json"];
export const pauseArgs = () => ["pause", "--herdr", "--json"];
export const resumeArgs = (due = false) => (due ? ["resume", "--due", "--json"] : ["resume", "--json"]);

// What an exec gave back: { reply } or { problem }.
export function readReply(result) {
  if (result.code !== 0) return { problem: firstLine(result.stderr) || `runway exited with ${result.code}` };
  try {
    return { reply: JSON.parse(result.stdout) };
  } catch {
    return { problem: "runway gave an answer that isn't JSON" };
  }
}

const firstLine = (text) => String(text ?? "").trim().split("\n")[0].slice(0, 200);
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const msOf = (iso) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? at : null;
};

// `on_size_change` reports window pixels, and everything drawn is in the app's own, scaled by the zoom.
export const appSize = (size, zoom = 1) => (size ? { width: size.width / zoom, height: size.height / zoom } : null);

// The moment the reply speaks for, so the words and the chart agree between reads.
export const nowOf = (reply) => msOf(reply?.now) ?? Date.now();

// The state word and its theme colour.
// Only when something is happening: paused, or the pausing watcher running. Otherwise there's no pill at all.
export function stateWord(reply) {
  if (reply?.pause) return { word: "Paused", colour: "blocked" };
  if (reply?.watching) return { word: "Watching", colour: "accent" };
  return null;
}

// The pausing watcher runs in a Herdr terminal of its own, kept by hc, so it outlives the panel. `watch --stop` ends it.
export const watchStartArgs = (program) => ["run", "--bg", "--no-parent", "--keep", "--label", "runway=watch", "--", program, "watch", "--act", "--herdr"];

/**
 * The header menu: the CLI's commands that make sense from here, for the state the reply is in.
 * Each item is { id, label, state, run, confirm }. run is { cli: args } for the runway CLI, or { watcher: "start" }.
 * confirm, when set, is the word on the button that runs it: anything that can pause agents asks first.
 */
export function menuOf(reply, now) {
  const items = [];
  // An older CLI doesn't say, so there's no state to show, and the press turns it on.
  const login = reply?.login === true, known = typeof reply?.login === "boolean";
  items.push({ id: "login", label: "Use Claude login", state: known ? (login ? "On" : "Off") : null, run: { cli: ["login", login ? "off" : "on"] }, confirm: null });
  items.push(reply?.watching
    ? { id: "watch", label: "Stop pausing watcher", state: null, run: { cli: ["watch", "--stop", "--json"] }, confirm: null }
    : { id: "watch", label: "Start pausing watcher", state: null, run: { watcher: "start" }, confirm: "Start watcher" });
  if (reply?.pause) items.push({ id: "resume", label: "Resume", state: null, run: { cli: ["resume", "--json"] }, confirm: null });
  else {
    items.push({ id: "pause-30m", label: "Pause for 30m", state: null, run: { cli: ["pause", "--herdr", "--for", "30m", "--json"] }, confirm: "Interrupt agents" });
    const next = (reply?.limits ?? []).map((l) => msOf(l.resetAt)).filter((ms) => ms !== null && ms > now).sort((a, b) => a - b)[0];
    if (next !== undefined) items.push({ id: "pause-reset", label: `Pause until ${axisTime(next, now)}`, state: "next reset", run: { cli: ["pause", "--herdr", "--until", new Date(next).toISOString(), "--json"] }, confirm: "Interrupt agents" });
  }
  items.push(reply?.hook
    ? { id: "hook", label: "Remove Claude Code hook", state: null, run: { cli: ["install-hook", "--user", "--remove", "--yes"] }, confirm: null }
    : { id: "hook", label: "Install Claude Code hook", state: null, run: { cli: ["install-hook", "--user", "--yes"] }, confirm: "Install hook" });
  return items;
}

// What the info button says.
export const INFO_LINES = [
  "Readings come from the runway CLI: Claude's usage caches or login, and Codex's session files, every minute.",
  "Each plane is a plan at its most at-risk limit. The far end is 100% and the sun is the reset.",
  "The sky and lights follow the forecast. Fog means there isn't one yet.",
  "It only pauses agents if you start the pausing watcher, or press Pause.",
];

// A limit's colour. Only a forecast can make it anything but calm, and with no forecast it claims nothing.
export function toneOf(limit, now) {
  const { state, hitsAt } = limit.forecast ?? {};
  if (state === "at-limit") return "blocked";
  if (state === "hits" && msOf(hitsAt) !== null) return msOf(hitsAt) - now <= URGENT_MS ? "blocked" : "working";
  return state === "safe" ? "accent" : "dim";
}

export const percentText = (used) => `${Math.round(used)}%`;

// A length as number and unit pairs, so the digits can be drawn larger than the units: 2h 06m, 46m, 3d 5h.
export function timeParts(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return [{ n: "<1", u: "m" }];
  if (minutes < 60) return [{ n: String(minutes), u: "m" }];
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return [{ n: String(hours), u: "h" }, { n: String(minutes % 60).padStart(2, "0"), u: "m" }];
  return [{ n: String(Math.floor(hours / 24)), u: "d" }, { n: String(hours % 24), u: "h" }];
}

export const shortTime = (ms) => timeParts(ms).map((p) => `${p.n}${p.u}`).join(" ");

const riskAt = (limit) => msOf(limit.forecast?.hitsAt) ?? Infinity;
const isRisk = (limit) => limit.forecast?.state === "at-limit" || (limit.forecast?.state === "hits" && riskAt(limit) !== Infinity);

// The one thing to say first: the limit that runs out soonest. With nothing running out, either every limit has a forecast
// that says it's safe, and the next reset is the news, or some limit has none, and the honest thing is the fullest limit and
// its reset. There's never a time to 100% without a forecast behind it.
export function heroOf(reply, now) {
  const limits = reply?.limits ?? [];
  if (!limits.length) return null;
  const risk = limits.filter(isRisk).sort((a, b) => riskAt(a) - riskAt(b))[0];
  if (risk?.forecast.state === "at-limit") return { limit: risk, label: `${risk.label} is at 100%. Resets in`, parts: timeParts(msOf(risk.resetAt) - now), tone: "blocked" };
  if (risk) return { limit: risk, label: `${risk.label} runs out in`, parts: timeParts(riskAt(risk) - now), tone: toneOf(risk, now) };

  const open = limits.filter((l) => msOf(l.resetAt) > now);
  if (open.length && limits.every((l) => l.forecast?.state === "safe")) {
    const next = [...open].sort((a, b) => msOf(a.resetAt) - msOf(b.resetAt))[0];
    return { limit: next, label: `Nothing at risk. ${next.label} resets in`, parts: timeParts(msOf(next.resetAt) - now), tone: "accent" };
  }
  const fullest = [...(open.length ? open : limits)].sort((a, b) => b.used - a.used)[0];
  if (!open.length) return { limit: fullest, label: fullest.label, parts: [{ n: String(Math.round(fullest.used)), u: "%" }], tone: "foreground" };
  const old = fullest.forecast?.state === "stale" ? `No reading for ${shortTime((fullest.forecast.ageMinutes ?? 0) * MINUTE)}. ` : "";
  return { limit: fullest, label: `${old}${fullest.label} resets in`, parts: timeParts(msOf(fullest.resetAt) - now), tone: "foreground" };
}

// Whose plan a limit is: the reply says, and an older reply's id or label starts with it.
export const providerOf = (limit) => String(limit.provider ?? String(limit.id ?? limit.label ?? "").split(/[.\s]/)[0]).toLowerCase();

// The only colours that aren't theme names. No theme name is orange in every theme (Meridian's ansi3 is amber in dark and
// `working` is blue), so Claude's plane has a fixed orange that reads on the runway in light and dark, and Codex's is white.
export const CLAUDE_ORANGE = "#ec7a3c";
export const PLANE_WHITE = "#ffffff";

const PLANE_ORDER = ["claude", "codex"];
// How far off the centreline each plane sits, in the runway's half-widths, when both are on it. Claude left, Codex right.
export const LANE = 0.46;

// One plane for each provider, at that provider's most at-risk limit: the one that runs out soonest (100% first), or with
// nothing running out, the fullest. Alone, a plane keeps the centreline.
export function planesOf(reply, now) {
  const groups = new Map();
  for (const limit of reply?.limits ?? []) {
    const provider = providerOf(limit);
    groups.set(provider, [...(groups.get(provider) ?? []), limit]);
  }
  const rank = (p) => (PLANE_ORDER.includes(p) ? PLANE_ORDER.indexOf(p) : PLANE_ORDER.length);
  const planes = [...groups].sort(([a], [b]) => rank(a) - rank(b)).slice(0, 2).map(([provider, limits]) => {
    const risk = limits.filter(isRisk).sort((a, b) => (a.forecast.state === "at-limit") === (b.forecast.state === "at-limit") ? riskAt(a) - riskAt(b) : a.forecast.state === "at-limit" ? -1 : 1)[0];
    return { provider, limit: risk ?? [...limits].sort((a, b) => (b.used ?? 0) - (a.used ?? 0))[0] };
  });
  return planes.map((plane, i) => ({ ...plane, lane: planes.length < 2 ? 0 : i === 0 ? -LANE : LANE }));
}

export const othersOf = (reply, hero) => (reply?.limits ?? []).filter((limit) => limit !== hero?.limit);

// What a secondary row adds beside its percent: how long is left, only when it's running out.
export function rowTime(limit, now) {
  if (limit.forecast?.state === "at-limit") return "Out";
  if (limit.forecast?.state === "stale") return `${shortTime((limit.forecast.ageMinutes ?? 0) * MINUTE)} old`;
  return isRisk(limit) ? shortTime(riskAt(limit) - now) : null;
}

// The pause line without the reason, which the hero and the chart already show.
export function pauseLine(reply) {
  const reason = String(reply?.pause?.reason ?? "").replace(/\.$/, "");
  return reason ? String(reply.pauseText ?? "").replace(` ${reason}.`, "") : reply?.pauseText ?? null;
}

const pad = (n) => String(n).padStart(2, "0");
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

// A time on the chart: the clock today, with the day in front on any other day.
export function axisTime(ms, now) {
  const date = new Date(ms);
  return date.toDateString() === new Date(now).toDateString() ? clock(date) : `${DAYS[date.getDay()]} ${clock(date)}`;
}

/**
 * A limit's history in fractions of its window: x from the window's start to its reset, y from 0% to 100%. Sparklines draw it.
 * @returns { start, end, line: [[x, y]], head }
 */
export function chartOf(limit, now) {
  const points = (limit.samples ?? []).filter((s) => Number.isFinite(s.t) && Number.isFinite(s.used)).sort((a, b) => a.t - b.t);
  const reset = msOf(limit.resetAt), forecast = limit.forecast ?? {};
  const first = points[0]?.t ?? now;
  const start = reset !== null && limit.windowMinutes ? Math.min(first, reset - limit.windowMinutes * MINUTE) : first;
  const end = reset ?? now + Math.max((now - first) / 4, 30 * MINUTE);
  const x = (t) => clamp((t - start) / (end - start || 1)), y = (used) => clamp(used / 100);
  const line = points.map((s) => [x(s.t), y(s.used)]);
  const head = line.at(-1) ?? (Number.isFinite(limit.used) ? [x(now), y(limit.used)] : null);
  return { start, end, line, head };
}

// A smooth curve through the points that never overshoots them (monotone cubic), so the line can't show usage that wasn't
// there. Each piece is { to, a, b }: where it ends and its two control points.
export function curveThrough(points) {
  const p = points.filter((point, i) => i === 0 || point[0] > points[i - 1][0]);
  if (p.length < 2) return [];
  const slopes = p.slice(1).map((point, i) => (point[1] - p[i][1]) / (point[0] - p[i][0]));
  const tangent = p.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === p.length - 1) return slopes.at(-1);
    const [before, after] = [slopes[i - 1], slopes[i]];
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });
  return p.slice(1).map((point, i) => {
    const third = (point[0] - p[i][0]) / 3;
    return { to: point, a: [p[i][0] + third, p[i][1] + tangent[i] * third], b: [point[0] - third, point[1] - tangent[i + 1] * third] };
  });
}

export const RUNWAY_LIGHTS = 15;
const DEPTH = 5;

// How the scene feels. Only a forecast can make it anything but fog, and a pause holds it whatever the forecast says.
export function moodOf(hero, reply) {
  if (reply?.pause) return "held";
  const { state } = hero.limit.forecast ?? {};
  if (state === "at-limit" || hero.tone === "blocked") return "danger";
  if (state === "hits") return "warn";
  return state === "safe" ? "calm" : "fog";
}

/**
 * What the scene shows of a limit, in fractions of the runway: 0 is where you started, 1 is 100%.
 * @returns { used, mood, landing, crossing: { at }, resetAt, now }
 *   landing: where a calm forecast says you'll stop at the reset. crossing: when a forecast says you'll reach the end.
 */
export function sceneOf(limit, mood, now) {
  const forecast = limit.forecast ?? {}, reset = msOf(limit.resetAt), used = clamp((limit.used ?? 0) / 100);
  const hitsAt = msOf(forecast.hitsAt);
  const crossing = (forecast.state === "hits" || forecast.state === "at-limit") && hitsAt !== null ? { at: hitsAt } : null;
  const landing = forecast.state === "safe" && forecast.burnPerHour > 0 && reset !== null && reset > now ? clamp(used + (forecast.burnPerHour * (reset - now)) / HOUR / 100) : null;
  return { used, mood, landing, crossing, resetAt: reset !== null && reset > now ? reset : null, now };
}

// The lights down both sides, nearest first. Behind you they've been passed. Ahead they say what the forecast says: white,
// then amber, then red up to the end, or white as far as a calm forecast reaches. With no forecast they claim nothing.
export function lightsOf(model, count) {
  return Array.from({ length: count }, (_, i) => {
    const d = (i + 1) / count;
    if (d <= model.used) return { d, kind: "past" };
    const ahead = (d - model.used) / (1 - model.used || 1);
    if (model.mood === "danger") return { d, kind: ahead < 0.3 ? "amber" : "red" };
    if (model.mood === "warn") return { d, kind: ahead < 0.34 ? "clear" : ahead < 0.7 ? "amber" : "red" };
    if (model.mood === "calm") return { d, kind: model.landing !== null && d <= model.landing ? "clear" : "dim" };
    return { d, kind: "dim" };
  });
}

// Where the chasing lights run: from you to the end, or to where a calm forecast stops. Held and fog have none.
export function chaseStops(model, count) {
  if (model.mood !== "calm" && model.mood !== "warn" && model.mood !== "danger") return [];
  const from = Math.min(0.97, model.used + 0.08), to = model.mood === "calm" ? model.landing : 0.98;
  if (to === null || to - from < 0.05) return [];
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

// One light's turn in the chase: on for its own step of the cycle, so together they run toward the far end.
export const chaseFrames = (index, count) => Array.from({ length: count + 3 }, (_, step) => (step === index ? "\u25CF" : ""));

// Where the horizon sits: under the hero, and never so low that the runway has no room.
export const horizonOf = (height, top) => Math.round(Math.max(Math.min(height - 110, top + 32), Math.min(height * 0.36, height - 110)));

// The runway in perspective. `at(d, u)` is a point on it: d is how far along, u is across it from -1 to 1. Its far end stops
// just short of the horizon, so the reset's sun comes up right behind it.
export function runwayOf(width, height, horizon) {
  const middle = width / 2, half = Math.min(width * 0.46, (height - horizon) * 1.7);
  const scale = (d) => 1 / (1 + DEPTH * d), far = scale(1) * 0.75;
  return { scale, half, at: (d, u = 0) => [middle + u * half * scale(d), horizon + ((height - horizon) * (scale(d) - far)) / (1 - far)] };
}

// Each character of a figure, for the board.
export const flapChars = (text) => [...String(text)];

export const controlWord = (reply, busy) => {
  if (busy === "pause") return "Pausing";
  if (busy === "resume") return "Resuming";
  return reply?.pause ? "Resume" : "Pause";
};
