// The hook, run as the real process Claude Code would start.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import test from "node:test";
import { denyReply, hold, HOOK_MARGIN, HOOK_TIMEOUT } from "../src/hook.js";
import { bin, iso, run, sandbox } from "./helpers.mjs";

const INPUT = JSON.stringify({ session_id: "made-up", tool_use_id: "toolu_1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/made/up", hook_event_name: "PreToolUse" });
const pause = (more = {}) => ({ version: 1, by: "watch", reason: "test", providers: ["claude"], until: iso(Date.now() + 3600000), ...more });

function startHook(env, args = []) {
  const child = spawn(process.execPath, [bin, "hook", ...args], { env });
  const result = { stdout: "", done: false, code: null };
  child.stdout.on("data", (d) => { result.stdout += d; });
  const finished = new Promise((resolve) => child.on("close", (code) => { result.done = true; result.code = code; resolve(result); }));
  child.stdin.end(INPUT);
  return { child, result, finished };
}

const until = async (check, ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

test("with no pause file a tool call goes straight through and prints nothing", async (t) => {
  const box = sandbox(t);
  const reply = await run(["hook"], box.env, { input: INPUT });
  assert.deepEqual([reply.code, reply.stdout, reply.stderr], [0, "", ""]);
});

test("a pause holds the call, and removing the file lets it go within two seconds", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", pause());
  const hook = startHook(box.env);
  assert.ok(await until(() => existsSync(box.paths.held) && readdirSync(box.paths.held).length === 1), "marked as held");
  assert.equal(hook.result.done, false);
  const released = Date.now();
  rmSync(box.paths.pause);
  const result = await hook.finished;
  assert.ok(Date.now() - released < 2500);
  assert.deepEqual([result.code, result.stdout], [0, ""]);
  assert.deepEqual(readdirSync(box.paths.held), []);
});

test("runway resume releases a held call", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", pause());
  const hook = startHook(box.env);
  assert.ok(await until(() => existsSync(box.paths.held) && readdirSync(box.paths.held).length === 1));
  const reply = await run(["resume"], box.env);
  assert.match(reply.stdout, /Resumed/);
  assert.equal((await hook.finished).code, 0);
});

test("the hold ends by itself at the pause's end, with nothing else running", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", pause({ until: iso(Date.now() + 1500) }));
  const started = Date.now();
  const result = await startHook(box.env).finished;
  assert.ok(Date.now() - started >= 1200);
  assert.deepEqual([result.code, result.stdout], [0, ""]);
});

test("a pause that has ended holds nothing, even if the file is still there", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", pause({ until: iso(Date.now() - 1000) }));
  const reply = await run(["hook"], box.env, { input: INPUT });
  assert.deepEqual([reply.code, reply.stdout], [0, ""]);
});

test("a pause for Codex alone doesn't hold Claude Code", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", pause({ providers: ["codex"] }));
  const reply = await run(["hook"], box.env, { input: INPUT });
  assert.deepEqual([reply.code, reply.stdout], [0, ""]);
});

test("a file that stays broken lets the call through", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", "{ not json");
  const reply = await run(["hook"], box.env, { input: INPUT });
  assert.deepEqual([reply.code, reply.stdout], [0, ""]);
});

test("one bad read doesn't let go: Windows can refuse a read during a rename", async () => {
  let reads = 0;
  const paths = { pause: "" };
  const fake = await import("../src/pause.js");
  assert.ok(fake.readPause);
  const result = await hold({
    paths: { ...paths, pause: "tests/does-not-exist" },
    maxHoldMs: 1000,
    now: () => { reads += 1; return reads; },
    sleep: async () => {},
  });
  assert.equal(result, "released");
});

test("at its hold limit the hook denies with a reason instead of letting the call through", async (t) => {
  const box = sandbox(t);
  box.writeState("pause.json", pause());
  const result = await startHook(box.env, ["--max-hold", "1"]).finished;
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(reply.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /runway resume/);
  assert.equal(result.code, 0);
});

test("the hook's limit sits inside Claude Code's timeout, and covers a weekly window", () => {
  assert.ok(HOOK_TIMEOUT - HOOK_MARGIN > 7 * 24 * 3600);
  assert.ok(HOOK_TIMEOUT * 1000 < 2 ** 31, "fits a JavaScript timer");
  assert.equal(denyReply("x").hookSpecificOutput.permissionDecisionReason, "x");
});

test("bad input on stdin changes nothing", async (t) => {
  const box = sandbox(t);
  assert.equal((await run(["hook"], box.env, { input: "not json" })).code, 0);
  box.writeState("pause.json", pause({ until: iso(Date.now() + 1200) }));
  assert.equal((await run(["hook"], box.env, { input: "not json" })).code, 0);
});
