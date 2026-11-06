// `runway hook`, Claude Code's PreToolUse hook. With no pause file it exits at once, which is the path every tool call
// takes. With one it holds the tool call: the hook simply doesn't return, so the agent waits with its context intact and
// spends nothing. It lets go when the file goes, when the pause's own end passes, or when its hold limit is near.
//
// Every failure here allows the tool call. A bug in runway must never stop someone's agent.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { files } from "./paths.js";
import { covers, pauseOver, readPause } from "./pause.js";

// Claude Code runs a hook for this many seconds, and if it's still going the tool call goes ahead. So install-hook sets
// HOOK_TIMEOUT, and the hook gives up HOOK_MARGIN earlier, to deny with a reason rather than let the call through.
export const HOOK_TIMEOUT = 8 * 24 * 3600;
export const HOOK_MARGIN = 60;
export const POLL_MS = 1000;

export const denyReply = (reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

export function readStdin(limitMs = 1000) {
  return new Promise((resolve) => {
    let text = "";
    const done = () => resolve(text);
    const timer = setTimeout(done, limitMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => { clearTimeout(timer); done(); });
    process.stdin.on("error", () => { clearTimeout(timer); done(); });
  });
}

const parse = (text) => {
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
};

const safeName = (text) => String(text ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

// A note for `runway status`: this agent is being held. It holds no prompt or tool input, only which call it was.
function markHeld(paths, input, now) {
  try {
    mkdirSync(paths.held, { recursive: true, mode: 0o700 });
    const name = `${safeName(input.session_id) || "session"}-${safeName(input.tool_use_id) || process.pid}.json`;
    const path = join(paths.held, name);
    writeFileSync(path, JSON.stringify({ pid: process.pid, session: input.session_id ?? null, tool: input.tool_name ?? null, cwd: input.cwd ?? null, since: new Date(now).toISOString() }), { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

const unmark = (path) => {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Only a note. status drops it when the pid is gone.
  }
};

// Holds until the pause ends. Returns "released", or "limit" if the hold limit came first.
export async function hold({ paths, maxHoldMs, now = Date.now, sleep }) {
  const started = now();
  let bad = 0;
  for (;;) {
    const pause = readPause(paths);
    if (!pause) return "released";
    // Windows can refuse a read for a moment during a rename. A file that stays unreadable can't say to hold.
    bad = pause.broken ? bad + 1 : 0;
    if (bad >= 3) return "released";
    if (!pause.broken && (!covers(pause, "claude") || pauseOver(pause, now()))) return "released";
    if (now() - started >= maxHoldMs) return "limit";
    await sleep(POLL_MS);
  }
}

export async function runHook({ args = [], env = process.env, stdinText, out = process.stdout, sleep, now = Date.now } = {}) {
  const paths = files(env.RUNWAY_HOME ? env.RUNWAY_HOME : undefined);
  const pause = readPause(paths);
  if (!pause || (!pause.broken && (!covers(pause, "claude") || pauseOver(pause, now())))) return 0;

  const input = parse(stdinText ?? (await readStdin()));
  const flag = args.indexOf("--max-hold");
  const maxHoldSeconds = flag >= 0 ? Number(args[flag + 1]) : HOOK_TIMEOUT - HOOK_MARGIN;
  const maxHoldMs = (Number.isFinite(maxHoldSeconds) && maxHoldSeconds > 0 ? maxHoldSeconds : HOOK_TIMEOUT - HOOK_MARGIN) * 1000;
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const mark = markHeld(paths, input, now());
  const stop = () => { unmark(mark); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  const result = await hold({ paths, maxHoldMs, now, sleep: wait });
  unmark(mark);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  process.off("SIGHUP", stop);

  if (result === "limit") {
    const reason = "limit-runway held this call as long as it can. Agents are still paused. Stop here. Run `runway resume` to carry on.";
    out.write(`${JSON.stringify(denyReply(reason))}\n`);
  }
  return 0;
}
