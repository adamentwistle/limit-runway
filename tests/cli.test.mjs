// The command line, end to end, against a fake `hc` and made-up caches.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseFor, parseUntil } from "../src/cli.js";
import { hookedFor, pickTargets, providerOf } from "../src/herdr.js";
import { iso, minutes, run, sandbox } from "./helpers.mjs";

const usage = (session, weekly = 10, resetIn = 120) => ({
  sessionUsage: session, sessionResetAt: iso(Date.now() + minutes(resetIn)),
  weeklyUsage: weekly, weeklyResetAt: iso(Date.now() + minutes(5000)),
  updatedAt: iso(Date.now()),
});
const agent = (address, name = "claude-code", status = "working", more = {}) => ({ address, agent: name, cwd: "/made/up", state: "live", status, ...more });

test("status --json has each limit and its forecast state", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(40));
  const reply = await run(["status", "--json"], box.env);
  assert.equal(reply.code, 0);
  const status = JSON.parse(reply.stdout);
  assert.deepEqual(status.limits.map((l) => l.id), ["claude.session", "claude.weekly"]);
  assert.equal(status.limits[0].forecast.state, "few-samples");
  assert.match(status.limits[0].text, /^too few samples/);
  assert.equal(status.pause, null);
});

test("status in words, with enough history to forecast", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(40));
  const rows = [];
  for (let m = 65; m >= 5; m -= 5) rows.push(JSON.stringify({ id: "claude.session", t: Date.now() - minutes(m), used: 40 - m / 2, resetAt: iso(Date.now() + minutes(600)) }));
  box.writeState("history.jsonl", `${rows.join("\n")}\n`);
  box.cache("orchi", { ...usage(40, 10, 600) });
  const reply = await run(["status"], box.env);
  assert.match(reply.stdout, /Claude 5-hour\s+40%\s+\d+\.\d%\/h\s+hits 100% at \S+( \S+)?, \d+h( \d+m)? before reset/);
  assert.match(reply.stdout, /Read from orchi/);
});

test("status with nothing to read says so and exits cleanly", async (t) => {
  const reply = await run(["status"], sandbox(t).env);
  assert.equal(reply.code, 0);
  assert.match(reply.stdout, /No limits found/);
  assert.match(reply.stdout, /No Claude Code usage found/);
});

test("--demo is made up, and writes nothing", async (t) => {
  const box = sandbox(t);
  const reply = JSON.parse((await run(["status", "--demo", "--json"], box.env)).stdout);
  assert.deepEqual(reply.limits.map((l) => l.forecast.state), ["hits", "safe", "safe", "few-samples"]);
  assert.ok(reply.limits[0].samples.length > 20);
  assert.equal(existsSync(box.paths.history), false);
});

test("watch reports only: no pause file, no hc, no command, without --act", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(97));
  box.terminals([agent("t7")]);
  const marker = join(box.home, "ran");
  const reply = await run(["watch", "--once", "--herdr", "--on-pause", `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','x')"`], box.env);
  assert.match(reply.stdout, /Reporting only/);
  assert.match(reply.stdout, /would pause until/);
  assert.equal(existsSync(box.paths.pause), false);
  assert.deepEqual(box.hcCalls(), []);
  assert.equal(existsSync(marker), false);
});

test("watch --act pauses: the pause file says why and until when", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(97));
  const reply = await run(["watch", "--once", "--act"], box.env);
  assert.match(reply.stdout, /paused until/);
  const pause = JSON.parse(readFileSync(box.paths.pause, "utf8"));
  assert.equal(pause.by, "watch");
  assert.deepEqual(pause.providers, ["claude"]);
  assert.deepEqual(pause.limits, ["claude.session"]);
  assert.match(pause.reason, /Claude 5-hour is at 97%/);
  assert.ok(Date.parse(pause.until) > Date.now() + minutes(115));
  assert.equal(existsSync(box.paths.watchLock), false);
  const status = JSON.parse((await run(["status", "--json"], box.env)).stdout);
  assert.match(status.pauseText, /^Paused until/);
});

test("a limit that resets within 15 minutes is left alone by --act", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(99, 10, 10));
  await run(["watch", "--once", "--act"], box.env);
  assert.equal(existsSync(box.paths.pause), false);
});

test("--pause-at changes the threshold", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(70));
  await run(["watch", "--once", "--act", "--pause-at", "60"], box.env);
  assert.equal(existsSync(box.paths.pause), true);
});

test("config.json sets the rules", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(70));
  box.writeState("config.json", { pauseAt: 60 });
  await run(["watch", "--once", "--act"], box.env);
  assert.equal(existsSync(box.paths.pause), true);
});

test("--herdr interrupts working agents on that plan and no others", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(97));
  box.terminals([
    agent("t1"), agent("t2", "claude-code", "idle"), agent("t3", "codex"), agent("t4", "pwsh.exe", undefined),
    agent("mac/t5"), agent("t9"),
  ]);
  await run(["watch", "--once", "--act", "--herdr"], { ...box.env, HC_TERMINAL_ID: "t9" });
  const calls = box.hcCalls();
  assert.deepEqual(calls.filter((c) => c[0] === "interrupt").map((c) => c[1]), ["t1"]);
  assert.ok(calls.every((c) => c[0] !== "send" && c[0] !== "kill" && c[0] !== "keys"));
  const pause = JSON.parse(readFileSync(box.paths.pause, "utf8"));
  assert.deepEqual(pause.herdr, [{ address: "t1", agent: "claude-code" }]);
});

test("at reset watch --act sends the resume line, once, and drops the pause", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(4));
  box.terminals([agent("t1", "claude-code", "idle"), agent("t2", "claude-code", "working")]);
  box.writeState("pause.json", { version: 1, by: "watch", reason: "made up", providers: ["claude"], until: iso(Date.now() - 1000), resumeLine: "carry on", herdr: [{ address: "t1" }, { address: "t2" }, { address: "t8" }] });
  const reply = await run(["watch", "--once", "--act"], box.env);
  assert.match(reply.stdout, /resumed/);
  assert.equal(existsSync(box.paths.pause), false);
  const sends = box.hcCalls().filter((c) => c[0] === "send");
  assert.deepEqual(sends, [["send", "t1", "carry on"]]);
  await run(["watch", "--once", "--act"], box.env);
  assert.equal(box.hcCalls().filter((c) => c[0] === "send").length, 1);
});

test("--on-pause and --on-resume run, with the reason in their environment", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(97));
  const log = join(box.home, "commands.log").replace(/\\/g, "/");
  const script = join(box.home, "note.cjs");
  writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(log)}, process.argv[2] + " " + process.env.RUNWAY_REASON + " " + process.env.RUNWAY_LIMITS + "\\n");`);
  const command = (word) => `node "${script.replace(/\\/g, "/")}" ${word}`;
  await run(["watch", "--once", "--act", "--on-pause", command("paused"), "--on-resume", command("resumed")], box.env);
  await run(["resume"], box.env);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^paused Claude 5-hour is at 97%.* claude\.session$/);
  assert.match(lines[1], /^resumed /);
});

test("after a manual resume watch doesn't pause again for the same window", async (t) => {
  const box = sandbox(t);
  box.cache("orchi", usage(97));
  await run(["watch", "--once", "--act"], box.env);
  assert.equal(existsSync(box.paths.pause), true);
  await run(["resume"], box.env);
  await run(["watch", "--once", "--act"], box.env);
  assert.equal(existsSync(box.paths.pause), false);
});

test("resume always releases: a broken file, hc failing, nothing paused", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", "{ broken");
  assert.equal((await run(["resume"], box.env)).code, 0);
  assert.equal(existsSync(box.paths.pause), false);

  box.writeState("pause.json", { by: "watch", herdr: [{ address: "t1" }] });
  const env = { ...box.env, RUNWAY_HC_ARGV: JSON.stringify(["no-such-program-here"]) };
  const reply = await run(["resume"], env);
  assert.equal(reply.code, 0);
  assert.equal(existsSync(box.paths.pause), false);

  assert.match((await run(["resume"], box.env)).stdout, /Nothing was paused/);
});

test("pause by hand: until resumed, for a length, until a time, and for one plan", async (t) => {
  const box = sandbox(t);
  await run(["pause"], box.env);
  let pause = JSON.parse(readFileSync(box.paths.pause, "utf8"));
  assert.equal(pause.until, null);
  assert.deepEqual(pause.providers, ["claude", "codex"]);
  assert.equal(pause.by, "manual");

  await run(["pause", "--for", "30m", "--provider", "codex"], box.env);
  pause = JSON.parse(readFileSync(box.paths.pause, "utf8"));
  assert.ok(Math.abs(Date.parse(pause.until) - Date.now() - minutes(30)) < 5000);
  assert.deepEqual(pause.providers, ["codex"]);

  assert.equal((await run(["pause", "--for", "soon"], box.env)).code, 2);
  assert.equal((await run(["pause", "--provider", "other"], box.env)).code, 2);
});

test("pause --herdr with no plan named takes any working agent, and a missing hc is reported, not fatal", async (t) => {
  const box = sandbox(t);
  box.terminals([agent("t1", "pi"), agent("t2", "codex")]);
  await run(["pause", "--herdr"], box.env);
  assert.deepEqual(box.hcCalls().filter((c) => c[0] === "interrupt").map((c) => c[1]), ["t1", "t2"]);
  const reply = await run(["pause", "--herdr", "--json"], { ...box.env, RUNWAY_HC_ARGV: JSON.stringify(["no-such-program-here"]) });
  assert.equal(JSON.parse(reply.stdout).herdrError, "hc not found");
  assert.equal(existsSync(box.paths.pause), true);
});

test("resume --due only acts once the pause is over", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", { by: "manual", until: iso(Date.now() + minutes(5)) });
  await run(["resume", "--due"], box.env);
  assert.equal(existsSync(box.paths.pause), true);
  box.writeState("pause.json", { by: "manual", until: iso(Date.now() - 1000) });
  await run(["resume", "--due"], box.env);
  assert.equal(existsSync(box.paths.pause), false);
  assert.equal(existsSync(box.paths.overrides), false);
});

test("a second acting watcher refuses to start", async (t) => {
  const box = sandbox(t);
  box.writeState("watch.lock", String(process.pid));
  const reply = await run(["watch", "--once", "--act"], box.env);
  assert.equal(reply.code, 1);
  assert.match(reply.stderr, /another runway watch/);
});

test("Claude Code terminals with the hook are left to the hook", (t) => {
  const box = sandbox(t);
  const project = join(box.home, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: 'node "/x/bin/runway.js" hook' }] }] } }));
  assert.equal(hookedFor(project, box.env), true);
  assert.equal(hookedFor(box.home, box.env), false);
  const list = [{ address: "t1", agent: "claude-code", status: "working", cwd: project }, { address: "t2", agent: "claude-code", status: "working", cwd: box.home }];
  const picked = pickTargets(list, { providers: ["claude"], hooked: (cwd) => hookedFor(cwd, box.env) });
  assert.deepEqual(picked.map((p) => p.address), ["t2"]);
});

test("--machines reaches agents on other machines", () => {
  const list = [{ address: "box/t1", agent: "codex", status: "working" }];
  assert.equal(pickTargets(list).length, 0);
  assert.equal(pickTargets(list, { machines: true }).length, 1);
  assert.equal(providerOf("claude-code"), "claude");
  assert.equal(providerOf("pwsh.exe"), null);
});

test("lengths and times parse, and bad ones don't", () => {
  assert.equal(parseFor("30m"), minutes(30));
  assert.equal(parseFor("2h"), minutes(120));
  assert.equal(parseFor("soon"), null);
  const noon = new Date(2026, 10, 6, 12).getTime();
  assert.equal(parseUntil("14:30", noon), new Date(2026, 10, 6, 14, 30).getTime());
  assert.equal(parseUntil("09:00", noon), new Date(2026, 10, 7, 9, 0).getTime());
  assert.equal(parseUntil("nonsense", noon), null);
});

test("an unknown command and a bad flag exit 2", async (t) => {
  const box = sandbox(t);
  assert.equal((await run(["fly"], box.env)).code, 2);
  assert.equal((await run(["status", "--nope"], box.env)).code, 2);
  assert.match((await run(["--help"], box.env)).stdout, /runway status/);
});

test("runway login on and off keep the rest of the config", async (t) => {
  const box = sandbox(t);
  mkdirSync(box.paths.dir, { recursive: true });
  writeFileSync(box.paths.config, JSON.stringify({ pauseAt: 90, sources: { codex: false } }));
  assert.equal((await run(["login", "on"], box.env)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(box.paths.config, "utf8")), { pauseAt: 90, sources: { codex: false, endpoint: true } });
  await run(["login", "off"], box.env);
  assert.equal(JSON.parse(readFileSync(box.paths.config, "utf8")).sources.endpoint, false);
  assert.notEqual((await run(["login", "maybe"], box.env)).code, 0);
});
