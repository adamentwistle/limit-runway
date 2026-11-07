// The panel's redesign: what the hero says, what the chart may draw, and the samples behind it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { demoStatus, CLAUDE_SESSION as CLI_SESSION } from "../src/demo.js";
import { series, withForecast } from "../src/sample.js";
import { root, run, sandbox } from "./helpers.mjs";
import { drawn, fakeCx, world } from "./stubs.mjs";

const { default: Runway } = await import("../herdr/mods/runway/main.js");
const { CLAUDE_SESSION, demoReply } = await import("../herdr/mods/runway/demo.js");
const {
  RUNWAY_LIGHTS, appSize, axisTime, chartOf, chaseFrames, chaseStops, curveThrough, flapChars, heroOf, planesOf, providerOf, horizonOf, lightsOf, moodOf, othersOf, pauseLine, rowTime, runwayOf, sceneOf, shortTime, timeParts,
} = await import("../herdr/mods/runway/logic.js");

const MIN = 60000, NOW = new Date(2026, 10, 6, 12, 0).getTime();
const at = (minutes) => new Date(NOW + minutes * MIN).toISOString();
const limit = (label, state, more = {}) => ({ id: label, label, used: 50, windowMinutes: 300, resetAt: at(120), samples: [], forecast: { state, burnPerHour: null, hitsAt: null }, ...more });
const hits = (label, minutes, more = {}) => limit(label, "hits", { forecast: { state: "hits", burnPerHour: 20, hitsAt: at(minutes) }, ...more });
const safe = (label, more = {}) => limit(label, "safe", { forecast: { state: "safe", burnPerHour: 5, hitsAt: null }, ...more });
const line = (count, from = -120) => Array.from({ length: count }, (_, i) => ({ t: NOW + (from + i * 10) * MIN, used: 10 + i * 4 }));
const text = (parts) => parts.map((p) => `${p.n}${p.u}`).join(" ");

test("the hero is the limit that runs out first", () => {
  const hero = heroOf({ limits: [hits("Later", 200), safe("Calm"), hits("Soon", 126)] }, NOW);
  assert.equal(hero.limit.label, "Soon");
  assert.equal(hero.label, "Soon runs out in");
  assert.equal(text(hero.parts), "2h 06m");
  assert.equal(hero.tone, "working");
});

test("the hero turns urgent inside an hour", () => {
  assert.equal(heroOf({ limits: [hits("Soon", 40)] }, NOW).tone, "blocked");
});

test("a limit already at 100% comes first, and the hero counts to its reset", () => {
  const full = limit("Full", "at-limit", { used: 100, resetAt: at(38), forecast: { state: "at-limit", hitsAt: at(0) } });
  const hero = heroOf({ limits: [hits("Soon", 5), full] }, NOW);
  assert.equal(hero.limit, full);
  assert.equal(hero.label, "Full is at 100%. Resets in");
  assert.equal(text(hero.parts), "38m");
  assert.equal(hero.tone, "blocked");
});

test("with nothing at risk the hero says so, with the next reset", () => {
  const hero = heroOf({ limits: [safe("Weekly", { resetAt: at(4000) }), safe("Session", { resetAt: at(174) })] }, NOW);
  assert.equal(hero.limit.label, "Session");
  assert.equal(hero.label, "Nothing at risk. Session resets in");
  assert.equal(text(hero.parts), "2h 54m");
  assert.equal(hero.tone, "accent");
});

test("it won't say nothing is at risk while a limit has no forecast", () => {
  const hero = heroOf({ limits: [safe("Session"), limit("New", "few-samples", { resetAt: at(4000) })] }, NOW);
  assert.equal(hero.label, "Session resets in");
  assert.equal(hero.tone, "foreground");
});

test("with no reset known the hero shows the fullest limit's level", () => {
  const hero = heroOf({ limits: [limit("Low", "no-reset", { used: 20, resetAt: null }), limit("High", "no-reset", { used: 64, resetAt: null })] }, NOW);
  assert.equal(hero.label, "High");
  assert.equal(text(hero.parts), "64%");
});

test("no limits, no hero", () => {
  assert.equal(heroOf({ limits: [] }, NOW), null);
});

test("a hits forecast with no time isn't treated as a risk", () => {
  const broken = limit("Broken", "hits", { forecast: { state: "hits", hitsAt: null } });
  assert.equal(heroOf({ limits: [broken] }, NOW).label, "Broken resets in");
  assert.equal(rowTime(broken, NOW), null);
});

test("the exact case: a stale Codex weekly at 10% can't take the hero from Claude weekly at 69%", () => {
  const codex = limit("Codex weekly", "stale", { used: 10, resetAt: at(7000), forecast: { state: "stale", ageMinutes: 480, hitsAt: null } });
  const claude = limit("Claude weekly", "few-samples", { used: 69, resetAt: at(5000) });
  const hero = heroOf({ limits: [codex, claude] }, NOW);
  assert.equal(hero.limit, claude);
  assert.equal(hero.label, "Claude weekly resets in");
  assert.equal(text(hero.parts), "3d 11h");
  assert.equal(rowTime(codex, NOW), "8h 00m old");
});

test("the fullest limit having gone stale says so", () => {
  const hero = heroOf({ limits: [limit("Old", "stale", { used: 80, forecast: { state: "stale", ageMinutes: 300 } }), safe("Calm", { used: 10 })] }, NOW);
  assert.equal(hero.label, "No reading for 5h 00m. Old resets in");
});

test("the other limits are everything but the hero", () => {
  const reply = { limits: [hits("Soon", 60), safe("Calm")] };
  assert.deepEqual(othersOf(reply, heroOf(reply, NOW)).map((l) => l.label), ["Calm"]);
});

test("a row adds its time only when it's running out", () => {
  assert.equal(rowTime(hits("Soon", 250), NOW), "4h 10m");
  assert.equal(rowTime(safe("Calm"), NOW), null);
  assert.equal(rowTime(limit("Full", "at-limit", { forecast: { state: "at-limit" } }), NOW), "Out");
});

test("times split into digits and units", () => {
  assert.equal(text(timeParts(126 * MIN)), "2h 06m");
  assert.equal(text(timeParts(46 * MIN)), "46m");
  assert.equal(text(timeParts(20 * MIN + 1)), "20m");
  assert.equal(text(timeParts(0)), "<1m");
  assert.equal(text(timeParts(-5 * MIN)), "<1m");
  assert.equal(text(timeParts((3 * 1440 + 310) * MIN)), "3d 5h");
  assert.equal(shortTime(90 * MIN), "1h 30m");
});

test("the pause line leaves out the reason the chart already shows", () => {
  const pause = { reason: "Claude 5-hour is forecast to hit 100% within 30 minutes" };
  assert.equal(pauseLine({ pause, pauseText: `Paused until 13:40. ${pause.reason}. 2 tool calls held.` }), "Paused until 13:40. 2 tool calls held.");
  assert.equal(pauseLine({ pause: {}, pauseText: "Paused until resumed." }), "Paused until resumed.");
  assert.equal(pauseLine({ pause: null, pauseText: null }), null);
});

test("a limit's history runs from the window's start to its reset", () => {
  const model = chartOf(hits("Soon", 60, { samples: line(13) }), NOW);
  assert.equal(model.start, NOW - 180 * MIN);
  assert.equal(model.end, NOW + 120 * MIN);
  assert.equal(model.line.length, 13);
  assert.deepEqual(model.head, model.line.at(-1));
});

test("no samples at all is only a dot at the reading", () => {
  const model = chartOf(limit("New", "few-samples", { used: 41 }), NOW);
  assert.deepEqual(model.line, []);
  assert.ok(Math.abs(model.head[1] - 0.41) < 1e-9);
});

const mood = (limit, reply = {}) => moodOf(heroOf({ limits: [limit] }, NOW), reply);

test("the mood comes from the forecast, and a pause holds it", () => {
  assert.equal(mood(safe("Calm")), "calm");
  assert.equal(mood(hits("Soon", 126)), "warn");
  assert.equal(mood(hits("Soon", 40)), "danger");
  assert.equal(mood(limit("Full", "at-limit", { used: 100, forecast: { state: "at-limit", hitsAt: at(0) } })), "danger");
  assert.equal(mood(hits("Soon", 40), { pause: {} }), "held");
  for (const state of ["few-samples", "stale", "no-reset", "reset-passed"]) assert.equal(mood(limit("Unknown", state)), "fog", state);
});

test("how far along you are is how much you've used, and a forecast is only drawn when there is one", () => {
  const soon = sceneOf(hits("Soon", 60, { used: 57 }), "warn", NOW);
  assert.equal(soon.used, 0.57);
  assert.equal(soon.crossing.at, NOW + 60 * MIN);
  assert.equal(soon.landing, null);
  const calm = sceneOf(safe("Calm", { used: 40 }), "calm", NOW);
  assert.ok(Math.abs(calm.landing - 0.5) < 1e-9); // 5% an hour for the two hours to the reset
  assert.equal(calm.crossing, null);
  for (const state of ["few-samples", "stale"]) {
    const model = sceneOf(limit("Unknown", state), "fog", NOW);
    assert.equal(model.landing, null, state);
    assert.equal(model.crossing, null, state);
  }
});

test("no reset known means no sun", () => {
  assert.equal(sceneOf(limit("Unknown", "no-reset", { resetAt: null }), "fog", NOW).resetAt, null);
  assert.equal(sceneOf(limit("Old", "reset-passed", { resetAt: at(-5) }), "fog", NOW).resetAt, null);
});

const kinds = (model) => lightsOf(model, RUNWAY_LIGHTS).map((l) => l.kind);

test("the lights ahead go white, amber, then red toward the end", () => {
  const all = kinds({ used: 0.3, mood: "warn", landing: null });
  assert.ok(all.indexOf("clear") < all.indexOf("amber") && all.indexOf("amber") < all.indexOf("red"));
  assert.equal(all.at(-1), "red");
  assert.equal(all[0], "past");
  assert.ok(!kinds({ used: 0.3, mood: "danger", landing: null }).includes("clear"));
});

test("a calm forecast lights the runway only as far as it reaches", () => {
  const all = lightsOf({ used: 0.3, mood: "calm", landing: 0.66 }, RUNWAY_LIGHTS);
  assert.ok(all.filter((l) => l.kind === "clear").every((l) => l.d <= 0.66));
  assert.ok(all.filter((l) => l.d > 0.66).every((l) => l.kind === "dim"));
  assert.ok(!all.some((l) => l.kind === "amber" || l.kind === "red"));
});

test("with no forecast, or held, the lights ahead claim nothing", () => {
  for (const mood of ["fog", "held"]) assert.deepEqual([...new Set(kinds({ used: 0.3, mood, landing: null }).filter((k) => k !== "past"))], ["dim"], mood);
});

test("the chase runs away from you, on one clock, and only when there's a forecast", () => {
  const stops = chaseStops({ used: 0.4, mood: "warn", landing: null }, 9);
  assert.equal(stops.length, 9);
  stops.forEach((stop, i) => assert.ok(stop > 0.4 && (i === 0 || stop > stops[i - 1])));
  for (const mood of ["fog", "held"]) assert.deepEqual(chaseStops({ used: 0.4, mood, landing: null }, 9), [], mood);
  assert.deepEqual(chaseStops({ used: 0.4, mood: "calm", landing: null }, 9), []);
  const lit = stops.map((_, i) => chaseFrames(i, 9).findIndex(Boolean));
  assert.deepEqual(lit, stops.map((_, i) => i));
  assert.equal(new Set(stops.map((_, i) => chaseFrames(i, 9).length)).size, 1);
});

test("the runway narrows toward its far end, and stops short of the horizon", () => {
  const rw = runwayOf(1000, 600, 200);
  assert.ok(rw.at(1)[1] > 200 && rw.at(1)[1] < rw.at(0.5)[1] && rw.at(0.5)[1] < rw.at(0)[1]);
  assert.equal(rw.at(0)[1], 600);
  const span = (d) => rw.at(d, 1)[0] - rw.at(d, -1)[0];
  assert.ok(span(0) > span(0.5) && span(0.5) > span(1) && span(1) > 0);
  assert.equal(rw.at(0.3, 1)[0] - 500, 500 - rw.at(0.3, -1)[0]);
});

test("the horizon clears the hero and leaves the runway room", () => {
  assert.ok(horizonOf(500, 150) >= 182);
  assert.ok(horizonOf(240, 150) <= 130);
});

test("the board has a tile for each character", () => {
  assert.deepEqual(flapChars("06"), ["0", "6"]);
  assert.deepEqual(flapChars("<1"), ["<", "1"]);
});

test("the curve goes through every point and never overshoots", () => {
  const points = [[0, 100], [10, 90], [20, 90], [30, 40], [40, 38], [50, 10]];
  const pieces = curveThrough(points);
  assert.deepEqual(pieces.map((p) => p.to), points.slice(1));
  pieces.forEach((piece, i) => {
    const [high, low] = [points[i][1], points[i + 1][1]];
    for (const control of [piece.a, piece.b]) assert.ok(control[1] <= high + 1e-9 && control[1] >= low - 1e-9, `piece ${i}`);
  });
});

test("the curve skips points that share a moment, and needs two", () => {
  assert.equal(curveThrough([[0, 1], [0, 2], [5, 3]]).length, 1);
  assert.deepEqual(curveThrough([[0, 1]]), []);
});

test("chart times carry the day only when it isn't today", () => {
  assert.equal(axisTime(NOW + 120 * MIN, NOW), "14:00");
  assert.equal(axisTime(NOW + 2880 * MIN, NOW), "Sun 12:00");
});

// The real view, at a size, against the stand-ins.
function open(props, size = { width: 340, height: 540 }) {
  world.props = props;
  const view = new Runway(), cx = fakeCx();
  view.init(props, cx);
  view.sized(size, cx);
  view.chartSized({ width: size.width, height: 220 }, cx);
  return { view, cx, tree: () => view.render() };
}

// Opens the panel as Herdr would at this zoom: sizes reach it in window pixels, from a box given in the app's own units.
function zoomed(zoom, demo, box) {
  world.zoom = zoom;
  drawn.length = 0;
  const { view, cx } = open({ demo }, { width: box.width * zoom, height: box.height * zoom });
  view.chartSized({ width: box.width * zoom, height: box.chart * zoom }, cx);
  drawn.length = 0;
  view.paths = {};
  const tree = view.render();
  world.zoom = 1;
  return { tree, paths: [...drawn] };
}

// A path's coordinates as percents of its box. Only percents can land the same on every platform, so a plain number fails here.
const numbers = (path) => path.calls.flatMap(([name, args]) => (name === "dash_array" ? [] : name === "add_polygon" ? args[0].flat() : args)).map((value) => {
  assert.match(String(value), /^-?\d+(\.\d+)?%$/);
  return parseFloat(value);
});
const pairs = (path) => numbers(path).map((value, i) => [i % 2 ? "y" : "x", value]);
const call = (element, name) => element.calls.findLast((c) => c[0] === name)?.[1][0];

function placed(element, out = []) {
  for (const kid of element.kids ?? []) {
    if (typeof kid === "object") {
      const left = call(kid, "left"), top = call(kid, "top");
      if (kid.tag !== "path" && left !== undefined) out.push({ left, top, width: call(kid, "size") ?? call(kid, "w") ?? String(kid.text()).length * 6.6 + 14, height: call(kid, "size") ?? call(kid, "h") ?? 14, id: kid.elementId ?? kid.text() });
      placed(kid, out);
    }
  }
  return out;
}

const ZOOMS = [1, 1.1, 1.2, 1.5, 2];
const BOXES = [{ width: 340, height: 700, chart: 420 }, { width: 1000, height: 760, chart: 470 }, { width: 1333, height: 833, chart: 560 }];
const SCENES = [true, "paused", "safe", "limit", "few", "stale"];
const MARKS = ["used-claude", "used-codex", "far-time", "landing", "reset-time"];

test("sizes reach the app's own units at any zoom", () => {
  assert.deepEqual(appSize({ width: 1200, height: 600 }, 1.2), { width: 1000, height: 500 });
  assert.equal(appSize(null, 1.2), null);
});

test("the scene stays inside its box at every zoom", () => {
  for (const zoom of ZOOMS) for (const box of BOXES) for (const demo of SCENES) {
    const { tree, paths } = zoomed(zoom, demo, box), label = `${demo} ${box.width} at ${zoom}`;
    assert.ok(paths.length > 8, label);
    for (const path of paths) for (const [axis, value] of pairs(path)) assert.ok(value >= -0.01 && value <= 100.01, `path ${axis} at ${value}%: ${label}`);
    for (const item of placed(tree.find("scene")).filter((i) => MARKS.includes(i.id))) {
      assert.ok(item.left >= 0 && item.left + item.width <= box.width + 0.001, `${item.id} at x ${item.left}: ${label}`);
      assert.ok(item.top >= 0 && item.top + item.height <= box.chart + 0.001, `${item.id} at y ${item.top}: ${label}`);
    }
  }
});

test("the reset's chip stays clear of the hero at every zoom, even in a short scene", () => {
  for (const zoom of ZOOMS) for (const chart of [300, 420, 560]) {
    const items = placed(zoomed(zoom, true, { width: 340, height: 700, chart }).tree.find("scene"));
    assert.ok(items.find((i) => i.id === "reset-time").top >= 12 + 32 + 10 + 22 + 65, `${chart} at ${zoom}`);
  }
});

test("the marks a state needs are all there at every zoom", () => {
  const ids = (demo, zoom) => placed(zoomed(zoom, demo, BOXES[1]).tree.find("scene")).map((i) => i.id).filter((id) => MARKS.includes(id)).sort();
  for (const zoom of ZOOMS) {
    assert.deepEqual(ids(true, zoom), ["far-time", "reset-time", "used-claude", "used-codex"], `at ${zoom}`);
    assert.deepEqual(ids("safe", zoom), ["landing", "reset-time", "used-claude", "used-codex"], `at ${zoom}`);
    assert.deepEqual(ids("few", zoom), ["reset-time", "used-claude", "used-codex"], `at ${zoom}`);
    assert.deepEqual(ids("stale", zoom), ["reset-time", "used-claude", "used-codex"], `at ${zoom}`);
  }
});

test("a zoom changes the size of the drawing and nothing about its shape", () => {
  const box = BOXES[1], base = zoomed(1, true, box);
  const flat = (t) => placed(t.find("scene")).filter((i) => MARKS.includes(i.id)).map((i) => [i.id, ...[i.left, i.top, i.width, i.height].map((n) => Math.round(n * 100) / 100)]);
  for (const zoom of ZOOMS.slice(1)) {
    const { tree, paths } = zoomed(zoom, true, box);
    assert.deepEqual(flat(tree), flat(base.tree), `elements at ${zoom}`);
    assert.equal(paths.length, base.paths.length);
    paths.forEach((path, i) => {
      assert.equal(path.width, base.paths[i].width);
      numbers(path).forEach((value, n) => assert.ok(Math.abs(value - numbers(base.paths[i])[n]) < 0.01, `path ${i} at ${zoom}`));
    });
  }
});

test("the layout goes by the app's own width, not the window's pixels", () => {
  for (const zoom of ZOOMS) {
    const narrow = zoomed(zoom, true, { width: 340, height: 700, chart: 300 }).tree;
    assert.equal(call(narrow.find("limit-claude weekly"), "h"), 34, `rows at ${zoom}`);
    const wide = zoomed(zoom, true, { width: 800, height: 700, chart: 300 }).tree;
    assert.equal(call(wide.find("limit-claude weekly"), "h"), 104, `tiles at ${zoom}`);
  }
});

test("tiles fill the row and no more at every zoom", () => {
  for (const zoom of ZOOMS) {
    const tree = zoomed(zoom, true, BOXES[1]).tree;
    const limits = demoReply(NOW).limits.slice(1).map((l) => call(tree.find(`limit-${l.id}`), "w"));
    assert.ok(Math.abs(limits.reduce((sum, w) => sum + w, 0) + 12 * (limits.length - 1) - (1000 - 48)) < 0.01, `at ${zoom}`);
  }
});

test("a change of zoom redraws the paths without a new measurement", () => {
  const { view, cx } = open({ demo: true }, { width: 1200, height: 900 });
  view.chartSized({ width: 1200, height: 400 }, cx);
  world.zoom = 1.5;
  view.render();
  const first = view.paths.scene.value;
  world.zoom = 1.2;
  view.render();
  assert.notEqual(view.paths.scene.value, first);
  world.zoom = 1;
});

test("the backdrop is ready before the first render, and a new reading doesn't rebuild it", () => {
  const { view, cx } = open({ demo: true }, { width: 1000, height: 760 });
  view.chartSized({ width: 1000, height: 470 }, cx);
  const made = view.paths.backdrop.value;
  view.render();
  assert.equal(view.paths.backdrop.value, made);
  view.reply = demoReply(NOW + 60000);
  view.render();
  assert.equal(view.paths.backdrop.value, made);
});

test("a held aircraft gets a stop bar, and nothing else does", () => {
  assert.ok(open({ demo: "paused" }).tree().find("stop-bar"));
  for (const demo of [true, "safe", "few", "stale"]) assert.equal(open({ demo }).tree().find("stop-bar"), null, String(demo));
});

test("every scene renders at a side panel's width and a tab's, with its control", () => {
  for (const demo of [true, "paused", "confirm", "safe", "limit", "few", "stale"]) {
    for (const width of [320, 1000]) {
      const tree = open({ demo }, { width, height: 700 }).tree();
      assert.ok(tree.find("scene"), `${demo} ${width}`);
      assert.ok(tree.find("hero"), `${demo} ${width}`);
      assert.ok(tree.find("control") || tree.find("confirm"), `${demo} ${width}`);
    }
  }
});

test("every limit is shown, however many there are", () => {
  const tree = open({ demo: true }, { width: 1000, height: 700 }).tree();
  for (const limit of demoReply(NOW).limits.slice(1)) assert.ok(tree.find(`limit-${limit.id}`), limit.id);
});

test("a short panel gives up the rows but keeps the chart and the control", () => {
  const tree = open({ demo: true }, { width: 340, height: 300 }).tree();
  assert.equal(tree.find("limits"), null);
  assert.ok(tree.find("scene"));
  assert.ok(tree.find("control"));
});

test("paths are kept between renders", () => {
  const { view, tree } = open({ demo: true });
  tree();
  const first = view.paths.scene.value;
  tree();
  assert.equal(view.paths.scene.value, first);
});

test("demo Pause asks first, like the real one, and Resume doesn't", () => {
  const { cx, tree } = open({ demo: true });
  tree().find("control").press({}, cx);
  assert.ok(tree().find("confirm"));
  assert.equal(tree().find("state").text(), "Watching");
  tree().find("interrupt").press({}, cx);
  assert.equal(tree().find("state").text(), "Paused");
  tree().find("control").press({}, cx);
  assert.equal(tree().find("state").text(), "Watching");
  assert.equal(tree().find("confirm"), null);
});

test("the view names theme colours and no others", () => {
  const code = readFileSync(join(root, "herdr", "mods", "runway", "view.js"), "utf8");
  assert.doesNotMatch(code, /#[0-9a-f]{3,8}\b/i);
  assert.ok(drawn.length > 0);
});

test("the demo curves only climb, and the panel's matches the CLI's", () => {
  assert.deepEqual(CLAUDE_SESSION, CLI_SESSION);
  for (const scene of ["watching", "paused", "safe", "limit", "few", "stale"]) {
    for (const { samples } of demoReply(NOW, scene).limits) samples.forEach((s, i) => assert.ok(i === 0 || s.used >= samples[i - 1].used, scene));
  }
});

test("the panel's demo reads as the CLI's does", () => {
  for (const [state, scene] of [["watching", "watching"], ["paused", "paused"]]) {
    const cli = demoStatus(NOW, state).limits, panel = demoReply(NOW, scene).limits;
    assert.deepEqual(panel.map((l) => l.label), cli.map((l) => l.label));
    assert.deepEqual(panel.map((l) => l.forecast.state), cli.map((l) => l.forecast.state));
    assert.deepEqual(panel.map((l) => Math.round(l.used)), cli.map((l) => Math.round(l.used)));
    const hitIn = (l) => (Date.parse(l.forecast.hitsAt) - NOW) / MIN;
    assert.ok(Math.abs(hitIn(cli[0]) - hitIn(panel[0])) < 2);
  }
});

test("the demo's hero reads 2h 06m", () => {
  const reply = demoReply(NOW);
  assert.equal(text(heroOf(reply, Date.parse(reply.now)).parts), "2h 06m");
  const cli = demoStatus(NOW);
  assert.equal(text(heroOf({ limits: cli.limits }, NOW).parts), "2h 06m");
});

test("a series is the current window's samples, oldest first", () => {
  const rows = [{ t: 1, used: 90 }, { t: 2, used: 95 }, { t: 3, used: 2 }, { t: 4, used: 6 }];
  assert.deepEqual(series(rows), [{ t: 3, used: 2 }, { t: 4, used: 6 }]);
});

test("a long series is thinned evenly, keeping the first and the newest", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ t: i * MIN, used: i / 50, resetAt: null, source: "x" }));
  const out = series(rows);
  assert.ok(out.length <= 72 && out.length > 60, String(out.length));
  assert.deepEqual(out[0], { t: 0, used: 0 });
  assert.deepEqual(out.at(-1), { t: 4999 * MIN, used: 4999 / 50 });
  const gaps = out.slice(1).map((s, i) => s.t - out[i].t);
  assert.ok(Math.max(...gaps) < 2.2 * Math.min(...gaps));
});

test("a short series is left whole, and an empty one is empty", () => {
  assert.equal(series(line(5)).length, 5);
  assert.deepEqual(series([]), []);
});

test("each limit carries only its own samples", () => {
  const rows = [{ id: "a", t: 1, used: 1 }, { id: "b", t: 1, used: 9 }, { id: "a", t: 2, used: 2 }];
  const limit = { id: "a", used: 2, resetAt: at(60), windowMinutes: 300, at: 2 };
  assert.deepEqual(withForecast(limit, rows, 3).samples, [{ t: 1, used: 1 }, { t: 2, used: 2 }]);
});

test("status --json carries a series from the history it keeps", async (t) => {
  const box = sandbox(t), now = Date.now(), resetAt = new Date(now + 120 * MIN).toISOString();
  const lines = [30, 20, 10].map((ago, i) => JSON.stringify({ id: "claude.session", t: now - ago * MIN, used: 40 + i * 2, resetAt, source: "orchi" }));
  box.writeState("history.jsonl", `${lines.join("\n")}\n`);
  box.cache("orchi", { sessionUsage: 46, sessionResetAt: resetAt, weeklyUsage: 10, weeklyResetAt: new Date(now + 5000 * MIN).toISOString(), updatedAt: new Date(now).toISOString() });
  const reply = JSON.parse((await run(["status", "--json"], box.env)).stdout);
  const session = reply.limits.find((l) => l.id === "claude.session");
  assert.deepEqual(session.samples.map((s) => s.used), [40, 42, 44, 46]);
  for (const sample of session.samples) assert.deepEqual(Object.keys(sample), ["t", "used"]);
});

test("a limit's provider comes from the reply, or from its id", () => {
  assert.equal(providerOf({ provider: "codex", id: "x" }), "codex");
  assert.equal(providerOf({ id: "claude.session" }), "claude");
  assert.equal(providerOf({ id: "Codex weekly" }), "codex");
});

test("each provider gets one plane, at its own most at-risk limit", () => {
  const planes = planesOf({ limits: [
    safe("cw", { provider: "claude", used: 70 }), hits("cs", 126, { provider: "claude", used: 40 }),
    safe("xs", { provider: "codex", used: 9 }), limit("xw", "few-samples", { provider: "codex", used: 30 }),
  ] }, NOW);
  assert.deepEqual(planes.map((p) => [p.provider, p.limit.id]), [["claude", "cs"], ["codex", "xw"]]);
  assert.ok(planes[0].lane < 0 && planes[1].lane > 0, "Claude left of the centreline, Codex right");
});

test("the soonest to run out wins within a provider, and 100% wins over that", () => {
  const planes = planesOf({ limits: [hits("a", 200, { provider: "codex" }), hits("b", 60, { provider: "codex" })] }, NOW);
  assert.equal(planes[0].limit.id, "b");
  const full = limit("f", "at-limit", { provider: "claude", used: 100, forecast: { state: "at-limit", hitsAt: at(0) } });
  assert.equal(planesOf({ limits: [hits("s", 5, { provider: "claude" }), full] }, NOW)[0].limit.id, "f");
});

test("one provider draws one plane on the centreline", () => {
  const planes = planesOf({ limits: [safe("cs", { provider: "claude" }), safe("cw", { provider: "claude", used: 80 })] }, NOW);
  assert.equal(planes.length, 1);
  assert.equal(planes[0].limit.id, "cw");
  assert.equal(planes[0].lane, 0);
  assert.deepEqual(planesOf({ limits: [] }, NOW), []);
});

test("the demo puts Claude and Codex on the runway, and the mood still follows the hero", () => {
  const reply = demoReply(NOW), planes = planesOf(reply, NOW), hero = heroOf(reply, NOW);
  assert.deepEqual(planes.map((p) => [p.provider, p.limit.label]), [["claude", "Claude 5-hour"], ["codex", "Codex 5-hour"]]);
  assert.equal(moodOf(hero, reply), "warn");
});
