// Runs the panel against stand-ins for Herdr: every state it can be in, and the control.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root } from "./helpers.mjs";
import { fakeCx, world } from "./stubs.mjs";

const { default: Runway } = await import("../herdr/mods/runway/main.js");
const { INSTALL_LINE, commandNames, stateWord, toneOf } = await import("../herdr/mods/runway/logic.js");

const WINDOWS = process.platform === "win32";
const AN_HOUR_ON = () => new Date(Date.now() + 2 * 3600000).toISOString();
const limit = (id, state, text, used = 50) => ({ id, label: id, used, forecast: { state, hitsAt: state === "hits" ? AN_HOUR_ON() : null }, text });
const status = (more = {}) => ({
  limits: [limit("Claude 5-hour", "hits", "hits 100% at 14:20, 2h 10m before reset", 72), limit("Claude weekly", "safe", "safe until reset, Mon 14:00", 40)],
  pause: null, pauseText: null, due: false, watching: true, notes: [], ...more,
});
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function script(...answers) {
  const asked = [];
  world.exec = async (command, args) => {
    asked.push({ command, args });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return asked;
}

async function open(props = {}) {
  world.props = props;
  const view = new Runway(), cx = fakeCx();
  view.init(props, cx);
  await cx.settled();
  return { view, cx, tree: () => view.render() };
}

test("it leads with the limit that runs out, and lists the rest with their percent", async () => {
  script(ok(status()));
  const { tree } = await open();
  assert.equal(tree().find("hero-label").text(), "Claude 5-hour runs out in");
  assert.match(tree().find("limit-Claude weekly").text(), /Claude weekly/);
  assert.match(tree().find("limit-Claude weekly").text(), /40%/);
  assert.equal(tree().find("limit-Claude 5-hour"), null);
  assert.equal(tree().find("state").text(), "Watching");
  assert.equal(tree().find("control").text(), "Pause");
});

test("it reads the CLI on a one-minute timer", async () => {
  const asked = script(ok(status()));
  const { cx } = await open();
  assert.deepEqual(asked[0].args, ["status", "--json"]);
  assert.equal(cx.repeating[0].ms, 60000);
  cx.repeating[0].handler(cx);
  await cx.settled();
  assert.equal(asked.length, 2);
});

test("Pause runs the CLI with Herdr included, then reads again", async () => {
  const asked = script(ok(status()), ok({ paused: true }), ok(status({ pause: { by: "manual" }, pauseText: "Paused until resumed." })));
  const { cx, tree } = await open();
  tree().find("control").press({}, cx);
  assert.equal(asked.length, 1);
  tree().find("interrupt").press({}, cx);
  assert.equal(tree().find("control").text(), "Pausing");
  await cx.settled();
  await cx.settled();
  assert.deepEqual(asked[1].args, ["pause", "--herdr", "--json"]);
  assert.equal(tree().find("state").text(), "Paused");
  assert.equal(tree().find("pause").text(), "Paused until resumed.");
  assert.equal(tree().find("control").text(), "Resume");
});

test("Cancel leaves the agents alone and brings Pause back", async () => {
  const asked = script(ok(status()));
  const { cx, tree } = await open();
  tree().find("control").press({}, cx);
  tree().find("cancel").press({}, cx);
  await cx.settled();
  assert.equal(asked.length, 1);
  assert.equal(tree().find("control").text(), "Pause");
});

test("Resume runs the CLI and goes back to Pause", async () => {
  const asked = script(ok(status({ pause: { by: "watch" }, pauseText: "Paused until 14:21." })), ok({ resumed: true }), ok(status()));
  const { cx, tree } = await open();
  tree().find("control").press({}, cx);
  await cx.settled();
  await cx.settled();
  assert.deepEqual(asked[1].args, ["resume", "--json"]);
  assert.equal(tree().find("control").text(), "Pause");
});

test("a second press while busy does nothing", async () => {
  const asked = script(ok(status()), ok({ paused: true }), ok(status()));
  const { cx, tree, view } = await open();
  tree().find("control").press({}, cx);
  tree().find("interrupt").press({}, cx);
  view.press(cx);
  await cx.settled();
  await cx.settled();
  assert.equal(asked.filter((a) => a.args[0] === "pause").length, 1);
});

test("a pause whose time is up is finished, and it reads again", async () => {
  const asked = script(ok(status({ pause: { by: "manual" }, due: true })), ok({ resumed: true }), ok(status()));
  const { tree } = await open();
  assert.deepEqual(asked[1].args, ["resume", "--due", "--json"]);
  assert.equal(tree().find("control").text(), "Pause");
});

test("with no CLI it says how to install it", async () => {
  const asked = script(new Error("program not found"));
  const { tree } = await open();
  assert.equal(asked.length, WINDOWS ? 2 : 1);
  assert.match(tree().find("missing").text(), /isn't installed/);
  assert.ok(tree().text().includes(INSTALL_LINE));
  assert.equal(tree().find("control"), null);
});

test("Windows tries npm's runway.cmd first", async () => {
  assert.deepEqual(commandNames(true), ["runway.cmd", "runway"]);
  assert.deepEqual(commandNames(false), ["runway"]);
});

test("props can name the CLI's full path", async () => {
  const asked = script(ok(status()));
  await open({ command: "C:/tools/runway.cmd" });
  assert.equal(asked[0].command, "C:/tools/runway.cmd");
});

test("once a name works it's the only one tried", async () => {
  const asked = script(ok(status()));
  const { cx } = await open();
  const first = asked[0].command;
  cx.repeating[0].handler(cx);
  await cx.settled();
  assert.equal(asked[1].command, first);
});

test("a failed CLI shows its error, and the last good numbers stay", async () => {
  script(ok(status()), { code: 1, stdout: "", stderr: "runway: boom\nmore" });
  const { cx, tree } = await open();
  cx.repeating[0].handler(cx);
  await cx.settled();
  assert.equal(tree().find("note").text(), "runway: boom");
  assert.match(tree().text(), /Claude 5-hour/);
});

test("an answer that isn't JSON is a problem, not a crash", async () => {
  script({ code: 0, stdout: "nope", stderr: "" });
  const { tree } = await open();
  assert.match(tree().find("note").text(), /isn't JSON/);
});

test("no limits says so", async () => {
  script(ok(status({ limits: [] })));
  const { tree } = await open();
  assert.match(tree().text(), /No limits found/);
});

test("demo mode needs no CLI, and its button toggles", async () => {
  const asked = script(new Error("never asked"));
  const { cx, tree } = await open({ demo: "paused" });
  assert.equal(asked.length, 0);
  assert.equal(cx.repeating.length, 0);
  assert.equal(tree().find("state").text(), "Paused");
  tree().find("control").press({}, cx);
  assert.equal(tree().find("control").text(), "Pause");
});

test("the state word and a limit's colour", () => {
  const now = Date.now(), inMinutes = (m) => new Date(now + m * 60000).toISOString();
  assert.equal(stateWord({ pause: {} }).word, "Paused");
  assert.equal(stateWord({ watching: true }).colour, "accent");
  assert.equal(stateWord({}).word, "Not watching");
  assert.equal(toneOf({ forecast: { state: "hits", hitsAt: inMinutes(30) } }, now), "blocked");
  assert.equal(toneOf({ forecast: { state: "hits", hitsAt: inMinutes(126) } }, now), "working");
  assert.equal(toneOf({ forecast: { state: "at-limit" } }, now), "blocked");
  assert.equal(toneOf({ forecast: { state: "safe" } }, now), "accent");
  assert.equal(toneOf({ forecast: { state: "few-samples" } }, now), "dim");
});

test("the mod uses no timers Herdr doesn't have, and no python", () => {
  const folder = join(root, "herdr", "mods", "runway");
  for (const name of readdirSync(folder).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(join(folder, name), "utf8");
    assert.doesNotMatch(code, /\b(setTimeout|clearTimeout|setInterval)\b/, name);
    assert.doesNotMatch(code, /python/i, name);
  }
});
