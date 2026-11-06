// Herdr's terminals, through `hc`. Used only when asked for with --herdr. Claude Code agents with the hook don't need this:
// the hook freezes them without losing the turn.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./sources/login.js";

const PROVIDER = { "claude-code": "claude", claude: "claude", codex: "codex" };

export const providerOf = (agent) => PROVIDER[String(agent ?? "").toLowerCase()] ?? null;

// Tests point this at a fake, as a JSON list of the program and its first arguments.
const hcArgv = (env) => {
  if (!env.RUNWAY_HC_ARGV) return ["hc"];
  return JSON.parse(env.RUNWAY_HC_ARGV);
};

export const hc = (args, { env = process.env, timeout = 15000 } = {}) => new Promise((resolve) => {
  const [program, ...first] = hcArgv(env);
  execFile(program, [...first, ...args], { timeout, windowsHide: true, env }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: error?.code === "ENOENT" });
  });
});

export async function listTerminals(options) {
  const reply = await hc(["ls", "--json"], options);
  if (!reply.ok) return { ok: false, missing: reply.missing, terminals: [] };
  try {
    const parsed = JSON.parse(reply.stdout);
    return { ok: true, terminals: Array.isArray(parsed?.terminals) ? parsed.terminals : Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, terminals: [] };
  }
}

const mentionsHook = (path) => {
  try {
    return /runway(\.js)?\\?["']?\s+hook/.test(readFileSync(path, "utf8")); // In JSON the closing quote comes escaped.
  } catch {
    return false;
  }
};

// Whether a Claude Code started in this folder would run the hook.
export const hookedFor = (cwd, env = process.env) => [
  ...(cwd ? [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")] : []),
  join(configDir(env), "settings.json"),
].some(mentionsHook);

/**
 * The terminals to interrupt: agents that are working, on a plan that's paused, and not this one.
 * @param providers the plans paused, or null for every agent
 */
export function pickTargets(terminals, { providers = null, self = null, machines = false, skipHooked = true, hooked = () => false } = {}) {
  return terminals.filter((t) => {
    if (t.status !== "working" || t.address === self) return false;
    if (String(t.address).includes("/") && !machines) return false;
    const provider = providerOf(t.agent);
    if (providers && !providers.includes(provider)) return false;
    if (provider === "claude" && skipHooked && hooked(t.cwd)) return false;
    return true;
  });
}

export async function interruptAll(targets, options) {
  return Promise.all(targets.map(async (t) => {
    const reply = await hc(["interrupt", t.address, "--timeout", "5", "--json"], { ...options, timeout: 12000 });
    return { address: t.address, agent: t.agent ?? null, ok: reply.ok };
  }));
}

// Sends the resume line to each terminal that's still there and isn't busy.
export async function sendAll(recorded, line, options) {
  const { terminals } = await listTerminals(options);
  const live = new Map(terminals.map((t) => [t.address, t]));
  return Promise.all(recorded.map(async (t) => {
    const now = live.get(t.address);
    if (!now) return { address: t.address, sent: false, why: "gone" };
    if (now.status === "working") return { address: t.address, sent: false, why: "working" };
    const reply = await hc(["send", t.address, line], { ...options, timeout: 20000 });
    return { address: t.address, sent: reply.ok, why: reply.ok ? null : "failed" };
  }));
}
