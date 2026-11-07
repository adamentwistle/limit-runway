// Runs the panel against stand-ins for Herdr: every state it can be in, and the control.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root } from "./helpers.mjs";
import { fakeCx, world } from "./stubs.mjs";

const { default: Runway } = await import("../herdr/mods/runway/main.js");
const { INFO_LINES, INSTALL_LINE, commandNames, menuOf, stateWord, toneOf, watchStartArgs } = await import("../herdr/mods/runway/logic.js");

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
  assert.equal(stateWord({}), null);
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

const { pinPlan, withBlock } = await import("../herdr/mods/runway/pin.js");
const terminals = () => ({ id: "root", type: "row", children: [{ id: "side", type: "column", children: [] }, { id: "work", type: "column", children: [{ id: "body", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }, { id: "panel", type: "column", children: [] }] }, { id: "status", type: "block" }] }] });
const withRunway = (hidden) => { const tree = terminals(); tree.children.push({ id: "r1", type: "block", content: { mod: "runway" }, ...(hidden ? { hidden: true } : {}) }); return tree; };

async function overlay(tree, layoutName = "mine") {
  Object.assign(world, { tree, layoutName, ran: [], commands: [] });
  script(ok(status()));
  return open({ overlay: "o1" });
}

test("a hidden runway block is shown by Pin to sidebar, and hidden by Unpin", async () => {
  const { cx, tree } = await overlay(withRunway(true));
  assert.equal(tree().find("pin").text(), "Pin to sidebar");
  tree().find("pin").press({}, cx);
  assert.deepEqual(world.ran, [{ name: "layout.show", args: { id: "r1" } }]);
  world.tree = withRunway(false);
  assert.equal(tree().find("pin").text(), "Unpin from sidebar");
  tree().find("pin").press({}, cx);
  assert.deepEqual(world.ran[1], { name: "layout.hide", args: { id: "r1" } });
});

test("a hidden column around the block is shown too", () => {
  const tree = terminals();
  tree.children.push({ id: "wrap", type: "column", hidden: true, children: [{ id: "r1", type: "block", content: { mod: "runway" } }] });
  assert.deepEqual(pinPlan(tree, "mine").commands, [["layout.show", { id: "wrap" }]]);
});

test("a person's own layout with no block gets one beside the side panel, and nothing else changes", async () => {
  const before = terminals();
  const { cx, tree } = await overlay(before);
  tree().find("pin").press({}, cx);
  assert.equal(world.ran[0].name, "layout.set");
  const body = world.ran[0].args.layout.children[1].children[0];
  assert.deepEqual(body.children.map((node) => node.id), ["main", "panel", "runway"]);
  assert.equal(body.children[2].size.px, 340);
  assert.deepEqual(before, terminals());
});

test("a new block's id doesn't take one in use", () => {
  const tree = terminals();
  tree.children[0].id = "runway";
  assert.equal(withBlock(tree).children[1].children[0].children[2].id, "runway-2");
});

test("a shipped layout with no block shows no pin button", async () => {
  const { tree } = await overlay(terminals(), "main");
  assert.equal(tree().find("pin"), null);
  assert.equal(pinPlan({ type: "column", children: [] }, "mine"), null);
});

test("the pin button is only in the overlay, and runway.pin presses it", async () => {
  Object.assign(world, { tree: withRunway(true), layoutName: "mine", ran: [], commands: [] });
  script(ok(status()));
  const { tree } = await open();
  assert.equal(tree().find("pin"), null);
  Object.assign(world, { ran: [], commands: ["pin"] });
  script(ok(status()));
  await open({ overlay: "o1" });
  assert.deepEqual(world.ran, [{ name: "layout.show", args: { id: "r1" } }]);
});

test("with nothing watching and nothing paused there's no pill", async () => {
  script(ok(status({ watching: false })));
  const { tree } = await open();
  assert.equal(tree().find("state"), null);
});

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ids = (items) => items.map((i) => i.id);

test("the menu offers what the CLI can do from here, and only what fits the state", () => {
  const reset = new Date(NOW + 90 * 60000).toISOString();
  const quiet = { limits: [{ id: "a", resetAt: reset }, { id: "b", resetAt: new Date(NOW + 9000 * 60000).toISOString() }], login: true, watching: false, pause: null, hook: false };
  const items = menuOf(quiet, NOW);
  assert.deepEqual(ids(items), ["login", "watch", "pause-30m", "pause-reset", "hook"]);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by.login.run, { cli: ["login", "off"] });
  assert.equal(by.login.state, "On");
  assert.equal(by.login.confirm, null);
  assert.deepEqual(by.watch.run, { watcher: "start" });
  assert.ok(by.watch.confirm, "starting the pausing watcher asks first");
  assert.deepEqual(by["pause-30m"].run, { cli: ["pause", "--herdr", "--for", "30m", "--json"] });
  assert.ok(by["pause-30m"].confirm);
  assert.deepEqual(by["pause-reset"].run, { cli: ["pause", "--herdr", "--until", reset, "--json"] });
  assert.ok(by["pause-reset"].confirm);
  assert.deepEqual(by.hook.run, { cli: ["install-hook", "--user", "--yes"] });
  assert.ok(by.hook.confirm);

  const busy = menuOf({ ...quiet, login: false, watching: true, pause: { by: "manual" }, hook: true }, NOW);
  assert.deepEqual(ids(busy), ["login", "watch", "resume", "hook"]);
  const now = Object.fromEntries(busy.map((i) => [i.id, i]));
  assert.deepEqual(now.login.run, { cli: ["login", "on"] });
  assert.equal(now.login.state, "Off");
  assert.deepEqual(now.watch.run, { cli: ["watch", "--stop", "--json"] });
  assert.deepEqual(now.resume.run, { cli: ["resume", "--json"] });
  assert.deepEqual(now.hook.run, { cli: ["install-hook", "--user", "--remove", "--yes"] });
  for (const item of [now.login, now.watch, now.resume, now.hook]) assert.equal(item.confirm, null, item.id);

  assert.deepEqual(ids(menuOf({ ...quiet, limits: [] }, NOW)), ["login", "watch", "pause-30m", "hook"]);
  const older = menuOf({ ...quiet, login: undefined }, NOW)[0];
  assert.equal(older.state, null, "an older CLI doesn't say");
  assert.deepEqual(older.run, { cli: ["login", "on"] });
});

test("the watcher starts in a kept Herdr terminal of its own", () => {
  assert.deepEqual(watchStartArgs("runway"), ["run", "--bg", "--no-parent", "--keep", "--label", "runway=watch", "--", "runway", "watch", "--act", "--herdr"]);
});

const menuReply = (more = {}) => status({ watching: false, login: true, hook: false, ...more });

test("the menu opens from its button and closes again", async () => {
  script(ok(menuReply()));
  const { cx, tree } = await open();
  assert.equal(tree().find("menu-list"), null);
  tree().find("menu").press({}, cx);
  assert.ok(tree().find("menu-list"));
  assert.match(tree().find("menu-login").text(), /Use Claude login/);
  assert.match(tree().find("menu-login").text(), /On/);
  tree().find("menu").press({}, cx);
  assert.equal(tree().find("menu-list"), null);
});

test("the login toggle runs at once, then reads again", async () => {
  const asked = script(ok(menuReply()), ok({}), ok(menuReply({ login: false })));
  const { cx, tree } = await open();
  tree().find("menu").press({}, cx);
  tree().find("menu-login").press({}, cx);
  await cx.settled();
  await cx.settled();
  assert.deepEqual(asked.slice(1).map((a) => a.args), [["login", "off"], ["status", "--json"]]);
  assert.equal(tree().find("menu-list"), null);
});

for (const [id, command, args] of [
  ["watch", "hc", watchStartArgs("runway")],
  ["pause-30m", "runway", ["pause", "--herdr", "--for", "30m", "--json"]],
  ["hook", "runway", ["install-hook", "--user", "--yes"]],
]) {
  test(`${id} asks first, Cancel does nothing, and the confirm runs it`, async () => {
    const asked = script(ok(menuReply()));
    const { cx, tree } = await open();
    tree().find("menu").press({}, cx);
    tree().find(`menu-${id}`).press({}, cx);
    assert.equal(asked.length, 1, "nothing runs on the first press");
    assert.ok(tree().find("menu-confirm"));
    tree().find("menu-cancel").press({}, cx);
    assert.equal(tree().find("menu-confirm"), null);
    await cx.settled();
    assert.equal(asked.length, 1, "Cancel runs nothing");

    tree().find(`menu-${id}`).press({}, cx);
    tree().find("menu-confirm").press({}, cx);
    await cx.settled();
    await cx.settled();
    if (!WINDOWS) assert.deepEqual([asked[1].command, asked[1].args], [command, args]);
    assert.deepEqual(asked.at(-1).args, ["status", "--json"]);
  });
}

test("stopping the watcher doesn't ask", async () => {
  const asked = script(ok(menuReply({ watching: true })));
  const { cx, tree } = await open();
  tree().find("menu").press({}, cx);
  tree().find("menu-watch").press({}, cx);
  await cx.settled();
  assert.deepEqual(asked[1].args, ["watch", "--stop", "--json"]);
});

test("the info button says how it works in a few short lines", async () => {
  script(ok(menuReply()));
  const { tree } = await open();
  assert.ok(tree().find("info"));
  assert.ok(INFO_LINES.length >= 3 && INFO_LINES.length <= 5);
  assert.match(INFO_LINES.join(" "), /watcher/);
  for (const line of INFO_LINES) assert.ok(line.length < 120, line);
});

test("runway.menu opens the overlay's menu", async () => {
  Object.assign(world, { tree: null, ran: [], commands: ["menu"] });
  script(ok(menuReply()));
  const { tree } = await open({ overlay: "o1" });
  assert.ok(tree().find("menu-list"));
});
