// The commands.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pauseNow, resumeNow } from "./actions.js";
import { loadConfig, saveLoginChoice } from "./config.js";
import { demoStatus } from "./demo.js";
import { duration, statusReply, statusText, when } from "./format.js";
import { hookedFor } from "./herdr.js";
import { applyInstall, planInstall } from "./install-hook.js";
import { ensureDir, files } from "./paths.js";
import { PROVIDERS, pauseOver, readPause } from "./pause.js";
import { LOGIN_NOTE, collect } from "./sample.js";
import { heldCount, releaseLock, takeLock, tick, watcherRunning } from "./watch.js";

const USAGE = `runway: forecasts when a plan limit runs out, and pauses agents before it does.

  runway status [--json]            each limit, its burn rate and forecast
  runway watch                      keeps sampling and says what it would do
  runway watch --act                pauses and resumes for real
  runway pause                      pauses now, until you resume
  runway resume                     releases everything at once
  runway hook                       the Claude Code PreToolUse hook
  runway install-hook --project [folder] | --user [--yes] [--remove]

watch and pause:
  --herdr                 interrupt Herdr's agent terminals, and send a line at reset
  --machines              include agents on other machines
  --on-pause <command>    run a command when pausing
  --on-resume <command>   run a command when resuming

watch:
  --pause-at <percent>    pause at this usage (default 95)
  --forecast-minutes <n>  pause when 100% is forecast within this long (default 30)
  --interval <seconds>    time between readings (default 60)
  --once                  one reading, then exit

pause:
  --for <30m|2h>          pause for this long
  --until <HH:MM|ISO>     pause until this time
  --provider <name>       claude or codex (default both)

status and watch:
  --no-endpoint           don't ask Claude's usage endpoint, read caches only

login:
  on | off                allow or refuse reading Claude's limits with your login
  --demo                  made-up data

State lives in ~/.limit-runway, or RUNWAY_HOME.`;

const say = (text) => process.stdout.write(`${text}\n`);
const shout = (text) => process.stderr.write(`runway: ${text}\n`);

const version = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version;

export const parseFor = (text) => {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(String(text).trim());
  if (!match) return null;
  return Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]];
};

export function parseUntil(text, now) {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (clock) {
    const date = new Date(now);
    date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const snapshot = (paths, env) => {
  const pause = readPause(paths);
  return {
    pause: pause?.broken ? { reason: "The pause file can't be read" } : pause,
    held: heldCount(paths),
    watching: watcherRunning(paths),
    hook: hookedFor(process.cwd(), env),
  };
};

async function askLogin() {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await lines.question("Runway has no fresh usage cache. It can read your Claude limits by sending your Claude Code login to api.anthropic.com, at most every 5 minutes. Allow this? [y/N] ");
  lines.close();
  return /^y(es)?$/i.test(answer.trim());
}

function login(args, paths) {
  const [choice] = args;
  if (choice !== "on" && choice !== "off") {
    shout("use `runway login on` or `runway login off`");
    return 2;
  }
  saveLoginChoice(choice === "on", paths);
  say(choice === "on" ? "Runway will use your Claude login when no usage cache is fresh." : "Runway won't use your Claude login.");
  return 0;
}

async function status(args, paths, env) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, demo: { type: "boolean" }, "demo-state": { type: "string" }, "no-endpoint": { type: "boolean" } } });
  const now = Date.now();
  let reply;
  if (values.demo) {
    const demo = demoStatus(now, values["demo-state"]);
    reply = statusReply(demo, { pause: demo.pause, held: demo.held, watching: true, hook: true }, now);
  } else {
    const config = loadConfig(paths);
    const useEnv = values["no-endpoint"] ? { ...env, RUNWAY_NO_ENDPOINT: "1" } : env;
    let reading = await collect({ paths, config, env: useEnv, now });
    if (reading.notes.includes(LOGIN_NOTE) && !values.json && process.stdin.isTTY && process.stdout.isTTY) {
      const allowed = await askLogin();
      saveLoginChoice(allowed, paths);
      reading = await collect({ paths, config: loadConfig(paths), env: useEnv, now });
    }
    reply = statusReply(reading, snapshot(paths, env), now);
  }
  say(values.json ? JSON.stringify(reply, null, 2) : statusText(reply));
  return 0;
}

const tickLine = (result, now) => {
  const time = when(now, now);
  const { decision } = result;
  if (result.did === "paused") return `${time} paused until ${when(Date.parse(result.report.pause.until), now)}: ${decision.reasons.join(". ")}`;
  if (result.did === "extended") return `${time} pause extended to ${when(Date.parse(decision.until), now)}: ${decision.reasons.join(". ")}`;
  if (result.did === "resumed") return `${time} resumed`;
  if (result.wouldDo === "pause") return `${time} would pause until ${when(Date.parse(decision.until), now)}: ${decision.reasons.join(". ")}`;
  if (result.wouldDo === "resume") return `${time} would resume`;
  if (result.wouldDo === "extend") return `${time} would extend the pause to ${when(Date.parse(decision.until), now)}`;
  return null;
};

async function watch(args, paths, env) {
  const { values } = parseArgs({
    args,
    options: {
      act: { type: "boolean" }, herdr: { type: "boolean" }, machines: { type: "boolean" }, once: { type: "boolean" }, json: { type: "boolean" },
      "on-pause": { type: "string" }, "on-resume": { type: "string" }, "pause-at": { type: "string" }, "forecast-minutes": { type: "string" },
      interval: { type: "string" }, "no-endpoint": { type: "boolean" },
    },
  });
  const config = loadConfig(paths);
  if (values["pause-at"] !== undefined) config.pauseAt = Number(values["pause-at"]);
  if (values["forecast-minutes"] !== undefined) config.forecastMinutes = Number(values["forecast-minutes"]);
  if (values.interval !== undefined) config.intervalSeconds = Number(values.interval);
  if (![config.pauseAt, config.forecastMinutes, config.intervalSeconds].every((n) => Number.isFinite(n) && n > 0)) {
    shout("--pause-at, --forecast-minutes and --interval take positive numbers.");
    return 2;
  }
  if (!values.act && (values.herdr || values["on-pause"] || values["on-resume"])) say("Reporting only. Nothing happens without --act.");

  ensureDir(paths.dir);
  if (values.act && !takeLock(paths)) {
    shout("another runway watch --act is running.");
    return 1;
  }
  const options = {
    act: Boolean(values.act), herdr: Boolean(values.herdr), machines: values.machines, onPause: values["on-pause"], onResume: values["on-resume"],
    config, env: values["no-endpoint"] ? { ...env, RUNWAY_NO_ENDPOINT: "1" } : env, paths,
  };

  let last = null, stopped = false, wake = null;
  const stop = () => { stopped = true; wake?.(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const now = Date.now();
      const result = await tick({ ...options, now });
      const line = tickLine(result, now);
      if (values.json) {
        say(JSON.stringify({ at: new Date(now).toISOString(), did: result.did, wouldDo: result.wouldDo ?? null, action: result.decision.action, limits: result.reading.limits.map((l) => ({ id: l.id, used: l.used, state: l.forecast.state })) }));
      } else if (line && line.slice(6) !== last) {
        say(line);
        last = line.slice(6);
      } else if (!line && last !== "") {
        say(`${when(now, now)} ${result.reading.limits.map((l) => `${l.label} ${Math.round(l.used)}%`).join(", ") || "no limits found"}`);
        last = "";
      }
      if (values.once || stopped) break;
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, config.intervalSeconds * 1000);
      });
    } while (!stopped);
  } finally {
    if (values.act) releaseLock(paths);
  }
  return 0;
}

async function pause(args, paths, env) {
  const { values } = parseArgs({
    args,
    options: {
      for: { type: "string" }, until: { type: "string" }, provider: { type: "string" }, herdr: { type: "boolean" }, machines: { type: "boolean" },
      "on-pause": { type: "string" }, "on-resume": { type: "string" }, reason: { type: "string" }, json: { type: "boolean" },
    },
  });
  const now = Date.now();
  let until = null;
  if (values.for) {
    const ms = parseFor(values.for);
    if (ms === null) { shout("--for takes a length like 30m, 2h or 1d."); return 2; }
    until = now + ms;
  } else if (values.until) {
    until = parseUntil(values.until, now);
    if (until === null) { shout("--until takes a time like 14:30 or an ISO date."); return 2; }
  }
  if (values.provider && !PROVIDERS.includes(values.provider)) { shout(`--provider is one of ${PROVIDERS.join(", ")}.`); return 2; }
  const report = await pauseNow(
    { by: "manual", reason: values.reason ?? "Paused by hand", providers: values.provider ? [values.provider] : null, until: until === null ? null : new Date(until).toISOString(), onResume: values["on-resume"] ?? null },
    { herdr: Boolean(values.herdr), machines: values.machines, onPause: values["on-pause"], config: loadConfig(paths), env, paths, now },
  );
  if (values.json) {
    say(JSON.stringify(report, null, 2));
    return 0;
  }
  say(until === null ? "Paused until you run runway resume." : `Paused until ${when(until, now)} (${duration(until - now)}).`);
  if (values.herdr) say(report.herdrError ?? `${report.interrupted.filter((t) => t.ok).length} Herdr terminals interrupted.`);
  if (!hookedFor(process.cwd(), env)) say("No Claude Code hook here, so Claude Code agents aren't held. See runway install-hook.");
  return 0;
}

async function resume(args, paths, env) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, due: { type: "boolean" }, "on-resume": { type: "string" } } });
  if (values.due && !pauseOver(readPause(paths), Date.now())) {
    say(values.json ? JSON.stringify({ resumed: false, why: "not due" }) : "Not due yet.");
    return 0;
  }
  const report = await resumeNow({ manual: !values.due, config: loadConfig(paths), env, paths, onResume: values["on-resume"] });
  if (values.json) {
    say(JSON.stringify(report, null, 2));
    return 0;
  }
  say(report.resumed ? "Resumed." : "Nothing was paused.");
  for (const t of report.sent) say(t.sent ? `Sent the resume line to ${t.address}.` : `Skipped ${t.address}: ${t.why}.`);
  return 0;
}

function installHook(args, paths, env) {
  const { values } = parseArgs({ args, options: { project: { type: "boolean" }, user: { type: "boolean" }, yes: { type: "boolean" }, remove: { type: "boolean" } }, allowPositionals: true, strict: true });
  const project = values.project ? (args.find((a) => !a.startsWith("--")) ?? true) : false;
  const plan = planInstall({ project, user: values.user, remove: values.remove, env, paths });
  if (plan.error) {
    shout(plan.error);
    return 2;
  }
  say(plan.path);
  if (plan.same) {
    say(values.remove ? "The hook isn't there. Nothing to do." : "The hook is already there. Nothing to do.");
    return 0;
  }
  say(plan.diff);
  if (!values.yes) {
    say("\nNot written. Run again with --yes to write it.");
    return 0;
  }
  applyInstall(plan);
  say("\nWritten.");
  return 0;
}

export async function main(argv, { env = process.env } = {}) {
  const [command, ...args] = argv;
  const paths = files(env.RUNWAY_HOME || undefined);
  try {
    switch (command) {
      case "status": return await status(args, paths, env);
      case "watch": return await watch(args, paths, env);
      case "pause": return await pause(args, paths, env);
      case "resume": return await resume(args, paths, env);
      case "install-hook": return installHook(args, paths, env);
      case "login": return login(args, paths);
      case "--version": case "-v": say(version()); return 0;
      case undefined: case "help": case "--help": case "-h": say(USAGE); return 0;
      default: shout(`no command called ${command}. Try runway --help.`); return 2;
    }
  } catch (error) {
    if (error.code?.startsWith?.("ERR_PARSE_ARGS")) {
      shout(error.message);
      return 2;
    }
    throw error;
  }
}

export { collect };
