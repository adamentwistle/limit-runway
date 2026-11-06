import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HOOK_TIMEOUT } from "../src/hook.js";
import { diffLines, hookCommand, isOurs, planInstall, stableScript, withHook, withoutHook } from "../src/install-hook.js";
import { run, sandbox } from "./helpers.mjs";

test("it needs to be told where, and writes nothing without --yes", async (t) => {
  const box = sandbox(t);
  const none = await run(["install-hook"], box.env, { cwd: box.home });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /--project/);

  const shown = await run(["install-hook", "--project"], box.env, { cwd: box.home });
  assert.equal(shown.code, 0);
  const path = join(box.home, ".claude", "settings.local.json");
  assert.ok(shown.stdout.includes(path));
  assert.match(shown.stdout, /\+ {2,}"PreToolUse"/);
  assert.match(shown.stdout, /Not written/);
  assert.equal(existsSync(path), false);
});

test("--yes writes the hook with its long timeout", async (t) => {
  const box = sandbox(t);
  const written = await run(["install-hook", "--project", "--yes"], box.env, { cwd: box.home });
  assert.match(written.stdout, /Written/);
  const settings = JSON.parse(readFileSync(join(box.home, ".claude", "settings.local.json"), "utf8"));
  const [group] = settings.hooks.PreToolUse;
  assert.equal(group.matcher, "*");
  assert.equal(group.hooks[0].type, "command");
  assert.equal(group.hooks[0].timeout, HOOK_TIMEOUT);
  assert.match(group.hooks[0].command, /^node ".*bin\/runway\.js" hook$/);
  assert.doesNotMatch(group.hooks[0].command, /\\/);
});

test("--project takes a folder", async (t) => {
  const box = sandbox(t);
  await run(["install-hook", "--project", "elsewhere", "--yes"], box.env, { cwd: box.home });
  assert.ok(existsSync(join(box.home, "elsewhere", ".claude", "settings.local.json")));
});

test("--user targets the settings in the config folder", async (t) => {
  const box = sandbox(t);
  await run(["install-hook", "--user", "--yes"], box.env, { cwd: box.home });
  assert.ok(existsSync(join(box.env.CLAUDE_CONFIG_DIR, "settings.json")));
});

test("everything already in the file stays, and a copy of it is kept", async (t) => {
  const box = sandbox(t);
  const dir = join(box.home, ".claude");
  mkdirSync(dir);
  const before = { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }] }], Stop: [{ hooks: [{ type: "command", command: "stop" }] }] } };
  writeFileSync(join(dir, "settings.local.json"), JSON.stringify(before));
  await run(["install-hook", "--project", "--yes"], box.env, { cwd: box.home });
  const after = JSON.parse(readFileSync(join(dir, "settings.local.json"), "utf8"));
  assert.equal(after.model, "x");
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, "other");
  assert.equal(after.hooks.Stop.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.local.json.before-runway"), "utf8")), before);
});

test("installing twice changes nothing, and --remove takes it out again", async (t) => {
  const box = sandbox(t);
  const dir = join(box.home, ".claude");
  mkdirSync(dir);
  const path = join(dir, "settings.local.json");
  const original = { model: "x" };
  writeFileSync(path, JSON.stringify(original));
  await run(["install-hook", "--project", "--yes"], box.env, { cwd: box.home });
  const again = await run(["install-hook", "--project", "--yes"], box.env, { cwd: box.home });
  assert.match(again.stdout, /already there/);
  await run(["install-hook", "--project", "--remove", "--yes"], box.env, { cwd: box.home });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
});

test("a settings file that isn't JSON is refused and left alone", async (t) => {
  const box = sandbox(t);
  const dir = join(box.home, ".claude");
  mkdirSync(dir);
  writeFileSync(join(dir, "settings.local.json"), "{ nope");
  const reply = await run(["install-hook", "--project", "--yes"], box.env, { cwd: box.home });
  assert.equal(reply.code, 2);
  assert.equal(readFileSync(join(dir, "settings.local.json"), "utf8"), "{ nope");
});

test("only runway's own hook is treated as ours", () => {
  assert.equal(isOurs({ command: hookCommand("/x/bin/runway.js") }), true);
  assert.equal(isOurs({ command: "runway hook" }), true);
  assert.equal(isOurs({ command: "my-hook" }), false);
  assert.equal(isOurs({ command: "cat runway.txt" }), false);
  const next = withHook({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "a" }, { type: "command", command: "runway hook" }] }] } }, "/x/bin/runway.js");
  assert.equal(next.hooks.PreToolUse[0].hooks.length, 1);
  assert.deepEqual(withoutHook(next).hooks.PreToolUse[0].hooks[0].command, "a");
});

test("run from npx, the hook gets a lasting copy of the tool", (t) => {
  const box = sandbox(t);
  const source = join(box.home, "npm-cache", "_npx", "abc", "node_modules", "limit-runway");
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "bin", "runway.js"), "");
  writeFileSync(join(source, "package.json"), "{}");
  const plan = planInstall({ project: true, cwd: box.home, env: box.env, paths: box.paths, source });
  assert.ok(plan.after.includes(join(box.state, "app").replace(/\\/g, "/")));
  stableScript(box.paths, source, true);
  assert.ok(existsSync(join(box.state, "app", "bin", "runway.js")));
});

test("the diff shows what's added and taken away", () => {
  assert.equal(diffLines("a\nb", "a\nc"), "  a\n+ c\n- b");
});
