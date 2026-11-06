// One GET of Claude's usage endpoint, at most every five minutes. The address is a constant: nothing in the settings, the
// environment or an answer can send the login anywhere else. Tests pass `target`; the command line never does.
import { files, readJson, writeJsonAtomic, ensureDir } from "../paths.js";
import { readLogin } from "./login.js";
import { limitsFromKeys, parseAnswer } from "./usage-answer.js";

export const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const TIMEOUT_MS = 10000;
const LARGEST = 1 << 20;
const INTERVAL = 300;
const HOUR = 3600;
const BROKEN = ["endpoint-changed", "no-login", "keychain-denied"];

export function retryAfter(value, now) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^[0-9]+$/.test(text)) return Number(text) > 0 ? Number(text) : null;
  const when = Date.parse(text);
  if (!Number.isFinite(when)) return null;
  const seconds = Math.ceil((when - now) / 1000);
  return seconds > 0 ? seconds : null;
}

export function outcome(code, headers, body, now) {
  if (code === 200) {
    const keys = parseAnswer(body);
    return keys ? { status: "ok", keys } : { status: "endpoint-changed" };
  }
  if (code === 401 || code === 403) return { status: "login-expired" };
  if (code === 429) return { status: "rate-limited", retry: retryAfter(headers["retry-after"], now) };
  if (code !== null && code >= 300 && code < 500 && code !== 408) return { status: "endpoint-changed" };
  return { status: "offline" };
}

export function waitFor(status, failures, retry) {
  if (status === "ok") return INTERVAL;
  if (BROKEN.includes(status)) return HOUR;
  if (status === "rate-limited") return Math.min(retry || INTERVAL, HOUR);
  const first = status === "login-expired" ? 900 : INTERVAL;
  return Math.min(first * 2 ** Math.min(Math.max(failures, 1) - 1, 8), HOUR);
}

// { code, headers, body }, with code null when there was no answer. A redirect comes back as itself and is not followed.
export async function requestUsage(token, target = ENDPOINT) {
  try {
    const reply = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA, "User-Agent": "limit-runway/0.1" },
    });
    const headers = Object.fromEntries(reply.headers);
    const body = await reply.text();
    return { code: reply.status, headers, body: body.length > LARGEST ? "" : body };
  } catch {
    return { code: null, headers: {}, body: "" }; // The error's text is never kept, in case it quotes the request.
  }
}

// Asks the endpoint if it's due. Returns { status, limits?, at? }. `status` "waiting" means it wasn't due.
export async function readEndpoint({ paths = files(), now = Date.now(), env = process.env, login = readLogin, request = requestUsage, target } = {}) {
  const before = readJson(paths.endpoint) ?? {};
  const due = (text) => {
    const ms = text ? Date.parse(text) : NaN;
    return !Number.isFinite(ms) || now >= ms;
  };
  if (!due(before.nextAt) || !due(before.retryAt)) return { status: "waiting", last: before.status ?? null };

  const found = await login({ env, now });
  let result = { status: found.status }, code = null;
  if (found.status === "ok") {
    const reply = await request(found.token, target);
    code = reply.code;
    result = outcome(reply.code, reply.headers, reply.body, now);
  }
  const failures = result.status === "ok" ? 0 : result.status === before.status ? (before.failures ?? 0) + 1 : 1;
  const wait = waitFor(result.status, failures, result.retry);
  ensureDir(paths.dir);
  writeJsonAtomic(paths.endpoint, {
    status: result.status,
    checkedAt: new Date(now).toISOString(),
    nextAt: new Date(now + wait * 1000).toISOString(),
    retryAt: result.retry ? new Date(now + Math.min(result.retry, HOUR) * 1000).toISOString() : null,
    failures,
    http: code,
  });
  if (result.status !== "ok") return { status: result.status };
  return { status: "ok", at: now, limits: limitsFromKeys(result.keys, { at: now, source: "endpoint" }) };
}
