// The drawing: a runway at dusk. You're the aircraft, how far along it is how much of the limit you've used, the far end is
// 100% and the sun on the horizon is the reset. Colours are theme names only, faded with an alpha on the end.
// Paths are kept on the view and made again only when the data or the size changes, because a render has about 55 ms.
// Everything here is in the app's own units, which `.w()` and `.left()` scale by the zoom. `on_size_change` reports window
// pixels, so `appSize` divides them. A path's coordinates are written as percents of its own box, so it lands on the elements
// around it at any zoom, whatever a platform does with a plain number.
import { Background, PathBuilder, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings } from "herdr";
import {
  INSTALL_LINE, RUNWAY_LIGHTS, appSize, axisTime, chartOf, chaseFrames, chaseStops, controlWord, curveThrough, flapChars, heroOf, horizonOf, lightsOf, moodOf, nowOf, othersOf,
  pauseLine, percentText, rowTime, runwayOf, sceneOf, stateWord, toneOf,
} from "./logic.js";

const WIDE = 640;
const MONO = "Geist Mono";
const ROW_H = 34;
const TILE_H = 104;
const TILE_INSET = 30;
const GAP = 12;
const NO_ROWS_BELOW = 430;
const SHORT = 340;
const CHASE_MS = { calm: 220, warn: 150, danger: 100 };

const tint = (colour, alpha) => `${colour.slice(0, 7)}${alpha}`;
const fade = (colour, from, to, angle = 180) => Background.linear_gradient(angle, Background.stop(tint(colour, from), 0), Background.stop(tint(colour, to), 1));
const layer = (path, paint, width, height) => window.paint_path(path, paint).absolute().left(0).top(0).w(width).h(height);

function kept(view, name, key, make) {
  const hit = view.paths[name];
  if (hit?.key === key) return hit.value;
  const value = make();
  view.paths[name] = { key, value };
  return value;
}

const signature = (limit, now) => `${limit.id}|${limit.used}|${limit.samples?.length}|${limit.samples?.at(-1)?.t}|${limit.forecast?.state}|${limit.forecast?.hitsAt}|${now}`;

// Takes the app's own units inside `box`, and writes percents of it.
function pen(path, box) {
  const sx = 100000 / box.width, sy = 100000 / box.height;
  const x = (value) => `${Math.round(value * sx) / 1000}%`, y = (value) => `${Math.round(value * sy) / 1000}%`;
  const api = {
    move: (left, top) => { path.move_to(x(left), y(top)); return api; },
    line: (left, top) => { path.line_to(x(left), y(top)); return api; },
    curve: (pixels) => {
      for (const { to, a, b } of curveThrough(pixels)) path.cubic_bezier_to(x(to[0]), y(to[1]), x(a[0]), y(a[1]), x(b[0]), y(b[1]));
      return api;
    },
    shape: (points) => { path.add_polygon(points.map(([left, top]) => [x(left), y(top)]), true); return api; },
    dash: (values) => { path.dash_array(values); return api; },
    close: () => { path.close(); return api; },
    build: () => path.build(),
  };
  return api;
}

const stroke = (width, box) => pen(PathBuilder.stroke(width), box);
const fill = (box) => pen(PathBuilder.fill(), box);
const stroked = (width, pixels, box) => stroke(width, box).move(pixels[0][0], pixels[0][1]).curve(pixels).build();
const filled = (pixels, base, box) => fill(box).move(pixels[0][0], base).line(pixels[0][0], pixels[0][1]).curve(pixels).line(pixels.at(-1)[0], base).close().build();
const drawable = (pixels) => pixels.length > 1 && pixels.at(-1)[0] - pixels[0][0] >= 2;
const rect = (box, left, top, right, bottom) => fill(box).shape([[left, top], [right, top], [right, bottom], [left, bottom]]).build();

// A stretch of the runway's surface: from one distance to another, and from one side to the other.
const patch = (rw, d0, d1, u0 = -1, u1 = 1) => [rw.at(d0, u0), rw.at(d0, u1), rw.at(d1, u1), rw.at(d1, u0)];
// A light. Far ones are a pixel or two across, so four corners are enough, and every point here costs render time.
const circle = (points) => Array.from({ length: points }, (_, i) => [Math.cos((i * 2 * Math.PI) / points), Math.sin((i * 2 * Math.PI) / points)]);
const ROUND = circle(10), DIAMOND = circle(4);
const spot = ([x, y], r) => (r < 2.2 ? DIAMOND : ROUND).map(([cx, cy]) => [x + cx * r, y + cy * r]);

// Seen from above with the nose pointing down the runway, then laid on it, so perspective shapes it like everything else.
const AIRCRAFT = [[0, 1], [0.07, 0.86], [0.09, 0.32], [0.82, -0.12], [0.82, -0.26], [0.09, -0.06], [0.07, -0.56], [0.3, -0.78], [0.3, -0.9], [0, -0.8]];
const aircraftShape = (rw, d, span, length) => [...AIRCRAFT, ...AIRCRAFT.slice(1, -1).reverse().map(([x, y]) => [-x, y])].map(([x, y]) => rw.at(d + y * length, x * span));

// Spread evenly by a small hash, so the stars stay put between renders.
const scatter = (i, salt) => { const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453; return v - Math.floor(v); };

// What only the size decides: it survives every reading, and a render only pays for it after a resize.
function backdrop(width, height, top) {
  const box = { width, height }, hy = horizonOf(height, top), rw = runwayOf(width, height, hy);
  const out = { rw, hy, sky: rect(box, 0, 0, width, hy), lowSky: rect(box, 0, hy * 0.35, width, hy), ground: rect(box, 0, hy, width, height), surface: fill(box).shape(patch(rw, 0, 1)).build(), foot: rect(box, 0, height * 0.86, width, height) };

  const stars = stroke(1.3, box), town = stroke(1.6, box);
  for (let i = 0; i < 40; i++) { const x = scatter(i, 1) * width, y = scatter(i, 2) * hy * 0.62; stars.move(x, y).line(x + 1, y); }
  for (let i = 0; i < 34; i++) { const x = scatter(i, 4) * width, y = hy - 1 - scatter(i, 5) * 3; town.move(x, y).line(x + 1.5, y); }
  Object.assign(out, { stars: stars.build(), town: town.build() });

  const field = stroke(1, box);
  for (const u of [1.5, 2.2, 3.2, 4.6, 6.6, 9.4]) for (const side of [-1, 1]) {
    const [fx, fy] = rw.at(1, u * side), [nx, ny] = rw.at(0, u * side), edge = side > 0 ? width : 0;
    const share = Math.min(1, (edge - fx) / (nx - fx));
    if (share > 0) field.move(fx, fy).line(fx + (nx - fx) * share, fy + (ny - fy) * share);
  }
  out.field = field.build();

  const paint = fill(box);
  for (let d = 0.09; d < 0.9; d += 0.066) paint.shape(patch(rw, d, d + 0.034, -0.022, 0.022));
  for (const start of [0.012, 0.935]) for (let u = -0.86; u < 0.8; u += 0.22) if (Math.abs(u + 0.06) > 0.1) paint.shape(patch(rw, start, start + 0.05, u, u + 0.12));
  for (const u of [-0.5, 0.36]) paint.shape(patch(rw, 0.16, 0.2, u, u + 0.14));
  out.paint = paint.build();
  const edges = fill(box);
  for (const u of [-1, 0.975]) edges.shape(patch(rw, 0, 1, u, u + 0.025));
  out.edges = edges.build();
  out.end = fill(box).shape(patch(rw, 0.985, 1, -1, 1)).build();
  return out;
}

// What the reading decides.
function drawings(model, base, width, height) {
  const box = { width, height }, { rw } = base, out = {};
  out.behind = fill(box).shape(patch(rw, 0, Math.max(0.001, model.used))).build();
  if (model.used < 1) out.ahead = fill(box).shape(patch(rw, model.used, 1)).build();

  const buckets = {};
  for (const light of lightsOf(model, RUNWAY_LIGHTS)) {
    const pens = (buckets[light.kind] ??= { dot: fill(box), halo: fill(box) });
    for (const u of [-1.06, 1.06]) {
      const at = rw.at(light.d, u), size = Math.max(1, 2.8 * rw.scale(light.d) * (width >= WIDE ? 1.6 : 1));
      pens.dot.shape(spot(at, size));
      pens.halo.shape(spot(at, size * 2.4));
    }
  }
  out.lights = Object.entries(buckets).map(([kind, pens]) => ({ kind, dot: pens.dot.build(), halo: pens.halo.build() }));

  // Far off the aircraft keeps a size you can read, because that's when it matters most.
  const you = Math.max(0.05, Math.min(0.95, model.used)), span = Math.max(0.5, 24 / (rw.half * rw.scale(you))), length = Math.min(0.15, 0.06 * (span / 0.5));
  out.you = you;
  out.aircraft = fill(box).shape(aircraftShape(rw, you, span, length)).build();
  out.shadow = fill(box).shape(aircraftShape({ at: (d, u) => { const [x, y] = rw.at(d, u); return [x + 2, y + 5]; } }, you, span, length)).build();
  if (model.landing !== null) out.landing = fill(box).shape(patch(rw, model.landing, model.landing + 0.014)).build();
  if (model.mood === "held") {
    const bar = fill(box), d = Math.min(0.96, you + 0.11);
    for (let u = -0.84; u <= 0.85; u += 0.28) bar.shape(spot(rw.at(d, u), Math.max(1.3, 4 * rw.scale(d))));
    out.stopBar = bar.build();
    out.stopAt = rw.at(d, 0);
  }
  if (model.mood === "fog") out.fog = fill(box).shape(patch(rw, Math.min(0.97, you + 0.08), 1, -1.5, 1.5)).build();
  return out;
}

const backdropOf = (view, width, height, top) => kept(view, "backdrop", `${width}x${height}|${top}`, () => backdrop(width, height, top));

// Called when the scene is measured, so the render that follows has only the reading to draw. It has about 55 ms, and the
// first one in a window starts cold.
export function prepare(view) {
  if (!view.plot) return;
  const zoom = settings()?.zoom || 1, panelSize = appSize(view.size, zoom) ?? { width: 340, height: 540 }, { width, height } = appSize(view.plot, zoom);
  backdropOf(view, width, height, topOf(panelSize.width, panelSize.height));
}

function palette(mood, t) {
  if (mood === "calm") return { high: t.accent, glow: t.ansi6, sun: t.ansi6 };
  if (mood === "warn") return { high: t.ansi5, glow: t.working, sun: t.working };
  if (mood === "danger") return { high: t.ansi5, glow: t.blocked, sun: t.blocked };
  return { high: t.dim, glow: t.dim, sun: t.muted };
}

const chip = (id, text, left, top, colour, t) => div().id(id).absolute().left(left).top(top).h(20).px(6).flex().items_center().rounded(5).bg(tint(t.surface, "d9")).border(1).border_color(tint(colour, "59"))
  .font_family(MONO).text_size(11).font_medium().text_color(colour).child(text);
const chipSize = (text) => text.length * 6.6 + 14;
const inside = (left, size, width) => Math.max(2, Math.min(width - size - 2, left));

function sun(d, model, colours, width, now, t) {
  const [x] = d.rw.at(1, 0), y = d.hy, ring = (size, alpha) => div().absolute().left(x - size / 2).top(y - size / 2).size(size).rounded_full().bg(tint(colours.sun, alpha));
  const reach = Math.min(width * 0.8, 340);
  const glow = Array.from({ length: 10 }, (_, i) => ring(reach * (1 - i / 11) ** 1.5, "0b"));
  if (model.resetAt === null) return { glow: [], core: [] };
  return { glow, core: [ring(Math.max(30, reach * 0.16), "ff").loop("opacity", { from: 0.74, to: 1, period: 5200 })] };
}

function chase(model, d) {
  const stops = chaseStops(model, 9);
  if (!stops.length) return [];
  const ms = CHASE_MS[model.mood];
  return stops.map((stop, i) => {
    const [x, y] = d.rw.at(stop, 0), size = Math.max(7, 26 * d.rw.scale(stop));
    return div().absolute().left(x - size).top(y - size).w(size * 2).h(size * 2).flex().items_center().justify_center().text_size(size).line_height(1).text_color(d.tone).frames(chaseFrames(i, stops.length), ms);
  });
}

function marks(model, d, limit, width, t, colours, tone) {
  const used = percentText(limit.used), size = chipSize(used), left = Boolean(model.crossing), [px, py] = d.rw.at(d.you, left ? -1 : 1);
  const items = [chip("you-used", used, inside(left ? px - size - 12 : px + 12, size, width), py - 12, t.foreground, t)];
  if (model.crossing) {
    const text = axisTime(model.crossing.at, model.now), [ex, ey] = d.rw.at(1, 1);
    items.push(chip("far-time", text, inside(ex + 8, chipSize(text), width), ey - 12, t.blocked, t));
  }
  if (model.landing !== null) {
    const text = percentText(model.landing * 100), [lx, ly] = d.rw.at(model.landing, -1);
    items.push(chip("landing", text, inside(lx - chipSize(text) - 8, chipSize(text), width), ly - 12, tone, t));
  }
  if (model.resetAt !== null) {
    const text = axisTime(model.resetAt, model.now), [sx] = d.rw.at(1, 0);
    items.push(chip("reset-time", text, inside(sx + 34, chipSize(text), width), d.hy - 26, colours.sun, t));
  }
  return items;
}

function scene(view, hero, now, reply, t, side, least, top, children) {
  const box = v_flex().id("scene").relative().flex_1().w_full().min_h(least).overflow_hidden().on_size_change((size, cx) => view.chartSized(size, cx));
  if (!view.plot) return box.children(children);

  const { width, height } = appSize(view.plot, settings()?.zoom || 1), limit = hero.limit, mood = moodOf(hero, reply), dark = settings()?.dark ?? true;
  const base = backdropOf(view, width, height, top);
  const { model, d } = kept(view, "scene", `${width}x${height}|${top}|${mood}|${signature(limit, now)}`, () => {
    const made = sceneOf(limit, mood, now);
    return { model: made, d: { ...base, ...drawings(made, base, width, height) } };
  });
  const colours = palette(mood, t), tone = t[hero.tone] ?? t.accent, ink = tone === t.foreground ? t.accent : tone;
  d.tone = ink;
  const on = (path, paint) => (path ? [layer(path, paint, width, height)] : []);
  const glow = sun(d, model, colours, width, now, t);
  const lightColour = { past: tint(t.accent, "99"), clear: dark ? t.foreground : t.accent, amber: t.working, red: t.blocked, dim: tint(t.dim, "80") };
  const risky = mood === "warn" || mood === "danger";
  return box
    .children(on(d.sky, fade(colours.high, "14", dark ? "6b" : "40")))
    .children(on(d.lowSky, fade(colours.glow, "00", dark ? "8c" : "59")))
    .children(dark ? on(d.stars, tint(t.foreground, "8c")) : [])
    .children(glow.glow)
    .children(glow.core)
    .children(on(d.ground, t.canvas))
    .children(on(d.ground, fade(colours.glow, dark ? "47" : "38", "00")))
    .children(on(d.town, tint(colours.glow, "cc")))
    .children(on(d.field, tint(t.foreground, "12")))
    .children(on(d.surface, fade(t.foreground, dark ? "2b" : "59", dark ? "12" : "38")))
    .children(on(d.behind, fade(t.accent, "26", "08")))
    .children(risky ? on(d.ahead, fade(t.blocked, mood === "danger" ? "8c" : "59", "00")) : [])
    .children(on(d.paint, tint(dark ? t.foreground : t.surface, dark ? "85" : "d9")))
    .children(on(d.edges, tint(dark ? t.foreground : t.surface, dark ? "59" : "b3")))
    .children(on(d.end, risky || mood === "held" ? t.blocked : tint(t.foreground, "40")))
    .children(on(d.landing, tone))
    .children(d.lights.flatMap((l) => [...on(l.halo, tint(lightColour[l.kind], "26")), ...on(l.dot, lightColour[l.kind])]))
    .children(on(d.fog, fade(dark ? t.muted : t.surface, dark ? "99" : "f2", "00")))
    .children(risky ? [div().absolute().left(d.rw.at(1, 0)[0] - 26).top(d.rw.at(1, 0)[1] - 13).w(52).h(26).rounded_full().bg(t.blocked).loop("opacity", { from: 0.08, to: 0.34, period: 2600 })] : [])
    .children(chase(model, d))
    .children(on(d.shadow, tint(dark ? t.background : t.foreground, dark ? "8c" : "40")))
    .children(on(d.aircraft, dark ? t.foreground : t.solid))
    .children(on(d.stopBar, t.blocked))
    .children(d.stopAt ? [div().id("stop-bar").absolute().left(d.stopAt[0] - 60).top(d.stopAt[1] - 12).w(120).h(24).rounded_full().bg(t.blocked).loop("opacity", { from: 0.06, to: 0.26, period: 3200 })] : [])
    .children(on(d.foot, fade(t.surface, "00", "ff")))
    .children(marks(model, d, limit, width, t, colours, ink))
    .children(children);
}

function spark(view, limit, now, width, height, t) {
  const colour = t[toneOf(limit, now)];
  const box = { width, height };
  const { head, line, area, track } = kept(view, `spark-${limit.id}`, `${width}x${height}|${signature(limit, now)}`, () => {
    const model = chartOf(limit, now);
    // A sparkline shows the shape, so it's scaled to its own level. The percent beside it says how high that is.
    const top = Math.min(1, Math.max(0.2, (limit.used / 100) * 1.2));
    const px = ([fx, fy]) => [2 + fx * (width - 6), 2 + (1 - fy / top) * (height - 4)];
    const pixels = model.line.map(px);
    return {
      head: model.head ? px(model.head) : null,
      line: drawable(pixels) ? stroked(1.5, pixels, box) : null,
      area: drawable(pixels) ? filled(pixels, height, box) : null,
      track: stroke(1, box).move(0, height - 0.5).line(width, height - 0.5).build(),
    };
  });
  return div().id(`spark-${limit.id}`).relative().w(width).h(height).flex_none()
    .child(layer(track, t.border, width, height))
    .when(Boolean(area), (e) => e.child(layer(area, fade(colour, "47", "00"), width, height)).child(layer(line, colour, width, height)))
    .when(Boolean(head), (e) => e.child(div().absolute().left(head[0] - 2.5).top(head[1] - 2.5).size(5).rounded_full().bg(colour)));
}

function readings(limit, now, size, t) {
  const time = rowTime(limit, now);
  return h_flex().flex_none().items_baseline().gap(8)
    .when(Boolean(time), (e) => e.child(div().font_family(MONO).text_size(12).font_medium().text_color(t[toneOf(limit, now)]).child(time)))
    .child(div().font_family(MONO).text_size(size).font_semibold().text_color(t.foreground).child(percentText(limit.used)));
}

const row = (view, limit, now, t) => h_flex().id(`limit-${limit.id}`).h(ROW_H).w_full().flex_none().items_center().gap(12)
  .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(limit.label))
  .child(spark(view, limit, now, 72, 22, t))
  .child(h_flex().flex_none().min_w(42).justify_end().child(readings(limit, now, 13, t)));

const tile = (view, limit, now, width, t) => v_flex().id(`limit-${limit.id}`).flex_none().w(width + TILE_INSET).h(TILE_H).gap(8).p(14).rounded(10).bg(t.background).border(1).border_color(t.border)
  .child(h_flex().items_center().justify_between().gap(8)
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(limit.label))
    .child(readings(limit, now, 18, t)))
  .child(spark(view, limit, now, width, 40, t));

// Up to four tiles a line, more lines when there are more limits, and two lines before it scrolls.
function tiles(view, limits, now, t, panelWidth, side) {
  const across = limits.length <= 4 ? limits.length : Math.ceil(limits.length / 2);
  const width = (panelWidth - 2 * side - GAP * (across - 1)) / across - TILE_INSET;
  const lines = [];
  for (let i = 0; i < limits.length; i += across) lines.push(limits.slice(i, i + across));
  const shown = Math.min(2, lines.length);
  return div().flex_none().px(side).pt(14).child(v_flex().id("limits").h(shown * TILE_H + (shown - 1) * GAP).gap(GAP).overflow_y_scrollbar().children(lines.map((line) => h_flex().flex_none().gap(GAP)
    .children(line.map((limit) => tile(view, limit, now, width, t))))));
}

function others(view, limits, now, t, panelWidth, wide, side) {
  if (!limits.length) return div();
  if (wide) return tiles(view, limits, now, t, panelWidth, side);
  return div().flex_none().px(side).pt(6).child(v_flex().id("limits").h(Math.min(4, limits.length) * ROW_H).overflow_y_scrollbar().children(limits.map((limit) => row(view, limit, now, t))));
}

function pill(state, t) {
  const colour = t[state.colour];
  return h_flex().flex_none().h(24).px(9).gap(6).items_center().rounded_full().bg(tint(t.surface, "bf")).border(1).border_color(tint(colour, "59"))
    .child(div().size(6).rounded_full().bg(colour))
    .child(div().id("state").text_size(12).font_medium().text_color(colour).child(state.word));
}

const button = (id, word, bg, fg, line, press) => h_flex().id(id).h(32).px(14).flex_1().items_center().justify_center().rounded(8).bg(bg).border(1).border_color(line).text_color(fg)
  .text_size(12.5).font_medium().when(Boolean(press), (e) => e.cursor_pointer().hover((s) => s.opacity(0.86)).on_click((_event, cx) => press(cx))).child(word);

function control(view, t) {
  const paused = Boolean(view.reply?.pause);
  if (view.confirming && !paused) {
    return h_flex().id("confirm").w_full().gap(8)
      .child(button("cancel", "Cancel", t.raised, t.foreground, t.border, (cx) => view.cancel(cx)))
      .child(button("interrupt", "Interrupt agents", t.blocked, t.background, t.blocked, (cx) => view.press(cx)));
  }
  return button("control", controlWord(view.reply, view.busy), paused ? t.solid : t.raised, paused ? t.solid_foreground : t.foreground, paused ? t.solid : t.border, view.busy ? null : (cx) => view.press(cx));
}

// Only in the overlay, and only where the layout can take it.
function pinControl(view, t) {
  const plan = view.pinning?.();
  if (!plan) return null;
  return button("pin", plan.pinned ? "Unpin from sidebar" : "Pin to sidebar", t.raised, t.foreground, t.border, (cx) => view.pin(cx)).flex_none().w_full();
}
const pinFoot = (view, t, side) => {
  const pin = pinControl(view, t);
  return pin ? [div().flex_1(), div().flex_none().px(side).pb(14).child(pin)] : [];
};

// One board tile for each character, split across the middle like a departures board.
function flap(char, h, colour, t) {
  const w = Math.round(h * 0.68);
  return div().relative().w(w).h(h).flex_none().flex().items_center().justify_center().rounded(Math.round(h * 0.1)).bg(tint(t.surface, "e6")).border(1).border_color(tint(colour, "40")).overflow_hidden()
    .font_family(MONO).text_size(Math.round(h * 0.76)).font_semibold().text_color(colour).child(char)
    .child(div().absolute().left(0).top(0).w(w).h(Math.round(h / 2)).bg(tint(t.foreground, "0a")))
    .child(div().absolute().left(0).top(Math.round(h / 2)).w(w).h(1).bg(tint(t.background, "cc")));
}

const flapHeight = (width, height) => (height < SHORT ? 44 : Math.round(Math.min(92, Math.max(62, width * 0.19))));
const topOf = (width, height) => (width >= WIDE ? 16 + 32 + 14 : 12 + 32 + 10) + 22 + flapHeight(width, height);

function heroBlock(hero, h, t) {
  const colour = t[hero.tone] ?? t.foreground;
  return v_flex().id("hero").flex_none().gap(6)
    .child(div().id("hero-label").truncate().text_size(13).font_medium().text_color(t.foreground).child(hero.label))
    .child(h_flex().items_end().gap(Math.round(h * 0.16)).children(hero.parts.map((part) => h_flex().items_end().gap(3)
      .children(flapChars(part.n).map((char) => flap(char, h, colour, t)))
      .child(div().pb(Math.round(h * 0.05)).pl(2).font_family(MONO).text_size(Math.round(h * 0.3)).font_medium().text_color(colour).child(part.u)))));
}

const message = (id, text, colour) => div().id(id).text_size(12).line_height(1.4).text_color(colour).child(text);

export function panel(view, t) {
  const { width, height } = appSize(view.size, settings()?.zoom || 1) ?? { width: 340, height: 540 }, wide = width >= WIDE, side = wide ? 24 : 16;
  const root = v_flex().id("root").size_full().bg(t.surface).on_size_change((size, cx) => view.sized(size, cx));
  const known = Boolean(view.reply) && !view.missing;
  const head = h_flex().flex_none().h(32).gap(10).px(side).mt(wide ? 16 : 12).items_center()
    .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child("Runway"))
    .when(Boolean(view.reply), (e) => e.child(pill(stateWord(view.reply), t)))
    .when(known && wide && Boolean(view.reply.limits?.length), (e) => e.child(h_flex().flex_none().gap(8).when(!view.confirming, (b) => b.w(104)).child(control(view, t))));

  if (view.missing) {
    return root.child(head).child(v_flex().id("missing").px(side).pt(12).gap(6)
      .child(div().text_size(13).text_color(t.foreground).child("The runway CLI isn't installed."))
      .child(div().text_size(12).font_family(MONO).text_color(t.muted).child(INSTALL_LINE))).children(pinFoot(view, t, side));
  }
  if (!view.reply) return root.child(head).child(div().px(side).pt(12).child(message("note", view.problem ?? "Reading", view.problem ? t.blocked : t.muted))).children(pinFoot(view, t, side));

  const now = nowOf(view.reply), hero = heroOf(view.reply, now);
  if (!hero) return root.child(head).child(div().px(side).pt(12).text_size(13).text_color(t.muted).child("No limits found.")).child(div().flex_1()).child(v_flex().flex_none().p(side).gap(10).child(control(view, t)).when(Boolean(pinControl(view, t)), (e) => e.child(pinControl(view, t))));

  const line = pauseLine(view.reply), notes = view.reply.notes ?? [], h = flapHeight(width, height);
  const top = topOf(width, height);
  return root
    .child(scene(view, hero, now, view.reply, t, side, height < SHORT ? 170 : 300, top, [head, div().flex_none().px(side).pt(wide ? 14 : 10).child(heroBlock(hero, h, t))]))
    .when(height >= NO_ROWS_BELOW, (e) => e.child(others(view, othersOf(view.reply, hero), now, t, width, wide, side)))
    .child(v_flex().flex_none().px(side).pt(10).pb(wide ? 20 : 14).gap(10)
      .when(Boolean(line), (e) => e.child(message("pause", line, t.foreground)))
      .when(Boolean(view.problem), (e) => e.child(message("note", view.problem, t.blocked)))
      .when(!view.problem && Boolean(notes.length), (e) => e.child(message("notes", notes.join(". "), t.muted)))
      .when(!wide, (e) => e.child(control(view, t)))
      .when(Boolean(pinControl(view, t)), (e) => e.child(pinControl(view, t))));
}
