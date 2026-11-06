// Turns the usage endpoint's answer, and the cache files written from it, into limits. The endpoint isn't a published API
// and its shape has changed before, so anything that doesn't look right counts as missing.
const RESET_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export const percent = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);

export function resetText(value) {
  if (typeof value !== "string" || value.length > 40 || !RESET_OK.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d+Z$/, "Z") : null;
}

const bucket = (answer, key) => {
  const b = answer[key];
  if (!b || typeof b !== "object") return [null, null];
  return [percent(b.utilization), resetText(b.resets_at)];
};

const fromList = (list, match) => {
  for (const item of list) {
    if (!item || typeof item !== "object" || !match(item)) continue;
    const used = percent(item.percent), reset = resetText(item.resets_at);
    if (used === null || (used === 0 && reset === null)) continue; // no usable number, or a placeholder
    return [used, reset];
  }
  return [null, null];
};

const modelName = (item) => {
  const name = item?.scope?.model?.display_name;
  return typeof name === "string" ? name : "";
};

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The endpoint's JSON text to the same keys the cache files use, plus any other model's weekly limit in `scoped`. Null when
// it has neither a session nor a weekly number, which means the endpoint has changed shape.
export function parseAnswer(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return null;
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const list = Array.isArray(answer.limits) ? answer.limits : [];
  const noFiveHour = "five_hour" in answer && answer.five_hour === null;
  const out = {};
  const put = (key, value) => { if (value !== null) out[key] = value; };

  if (noFiveHour) {
    out.sessionUsage = 0; // no 5-hour limit: no reset, and nothing from limits[]
  } else {
    const [used, reset] = bucket(answer, "five_hour");
    const [listed, listedReset] = fromList(list, (i) => i.kind === "session");
    put("sessionUsage", used ?? listed);
    put("sessionResetAt", reset ?? listedReset);
  }
  const [weekly, weeklyReset] = bucket(answer, "seven_day");
  const [listed, listedReset] = fromList(list, (i) => i.kind === "weekly_all");
  put("weeklyUsage", weekly ?? listed);
  put("weeklyResetAt", weeklyReset ?? listedReset);

  const scoped = [];
  const names = new Set(list.filter((i) => i?.kind === "weekly_scoped").map(modelName).filter(Boolean));
  for (const name of names) {
    const [used, reset] = fromList(list, (i) => i.kind === "weekly_scoped" && modelName(i) === name);
    if (used !== null) scoped.push({ name, used, resetAt: reset });
  }
  if (scoped.length) out.scoped = scoped;

  if (!("weeklyUsage" in out) && (!("sessionUsage" in out) || noFiveHour)) return null;
  return out;
}

// Cache keys to limits. A usage of 0 with no reset means the account has no such limit.
export function limitsFromKeys(keys, { at, source }) {
  const out = [];
  const add = (id, label, windowMinutes, used, resetAt) => {
    const value = percent(used);
    if (value === null) return;
    const reset = resetText(resetAt);
    if (value === 0 && !reset) return;
    out.push({ id, provider: "claude", label, windowMinutes, used: value, resetAt: reset, at, source });
  };
  add("claude.session", "Claude 5-hour", 300, keys.sessionUsage, keys.sessionResetAt);
  add("claude.weekly", "Claude weekly", 10080, keys.weeklyUsage, keys.weeklyResetAt);
  if (Array.isArray(keys.scoped)) {
    for (const s of keys.scoped) add(`claude.weekly.${slug(s.name)}`, `Claude weekly ${s.name}`, 10080, s.used, s.resetAt ?? keys.weeklyResetAt);
  } else {
    add("claude.weekly.fable", "Claude weekly Fable", 10080, keys.fableUsage, keys.fableResetAt ?? keys.weeklyResetAt);
    add("claude.weekly.opus", "Claude weekly Opus", 10080, keys.weeklyOpusUsage, keys.weeklyResetAt);
    add("claude.weekly.sonnet", "Claude weekly Sonnet", 10080, keys.weeklySonnetUsage, keys.weeklyResetAt);
  }
  return out.filter((limit) => limit.used > 0 || limit.id === "claude.session" || limit.id === "claude.weekly");
}
