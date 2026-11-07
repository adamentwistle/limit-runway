// Stand-ins for Herdr's modules, so the mod's own files can run under `node --test`. This proves the mod's logic, not that
// the real app accepts its calls: `herdr-app check` does that.
import { registerHooks } from "node:module";

export class El {
  constructor(tag) { this.tag = tag; this.kids = []; this.calls = []; this.press = null; this.elementId = null; }
  child(value) { if (value !== undefined && value !== null) this.kids.push(value); return this; }
  children(list) { for (const value of list) this.child(value); return this; }
  when(on, change) { return on ? change(this) : this; }
  on_click(press) { this.press = press; return this; }
  id(value) { this.elementId = value; return this; }
  hover(style) { style(element("hover")); return this; }
  text() { return this.kids.map((k) => (k instanceof El ? k.text() : String(k))).join(" "); }
  find(id) {
    if (this.elementId === id) return this;
    for (const k of this.kids) {
      const found = k instanceof El ? k.find(id) : null;
      if (found) return found;
    }
    return null;
  }
}

export const element = (tag) => new Proxy(new El(tag), {
  get(target, name, self) {
    if (name in target || typeof name === "symbol") {
      const value = target[name];
      return typeof value === "function" ? value.bind(self) : value;
    }
    return (...args) => { target.calls.push([name, args]); return self; };
  },
});

export const world = { exec: async () => ({ code: 0, stdout: "{}", stderr: "" }), props: {}, zoom: 1, tree: null, layoutName: "mine", ran: [], commands: [] };

export const theme = Object.fromEntries(["surface", "raised", "hover", "foreground", "muted", "dim", "solid", "solid_foreground", "blocked", "working", "accent", "border", "input", "popover", "background", "canvas", "ansi5", "ansi6"].map((name, i) => [name, `#${String(i + 10).repeat(3)}`]));

// Paths and paints are only recorded: `drawn` holds each path a render asked for, with the calls that made it.
export const drawn = [];
const pen = (kind, width) => {
  const calls = [];
  const path = new Proxy({}, { get: (_target, name) => (name === "build" ? () => ({ kind, width, calls }) : (...args) => { calls.push([name, args]); return path; }) });
  return path;
};
export const PathBuilder = { fill: () => pen("fill"), stroke: (width) => pen("stroke", width) };
const paint = { color_space: () => paint };
export const Background = { stop: (colour, at) => ({ colour, at }), linear_gradient: () => paint, pattern_slash: () => paint };
globalThis.window = { paint_path: (path) => { drawn.push(path); return element("path"); } };

const stubs = {
  "gpui-kit": `import { element } from ${JSON.stringify(import.meta.url)};
export class View {}
export { Background, PathBuilder } from ${JSON.stringify(import.meta.url)};
export const div = () => element("div");`,
  "gpui-base": `import { element } from ${JSON.stringify(import.meta.url)};
export const v_flex = () => element("v_flex");
export const h_flex = () => element("h_flex");`,
  herdr: `import { world, theme as colours } from ${JSON.stringify(import.meta.url)};
export const exec = (...args) => world.exec(...args);
export const props = () => world.props;
export const layout = () => world.tree;
export const nextCommand = () => (world.commands.length ? Promise.resolve(world.commands.shift()) : new Promise(() => {}));
export const run = (name, args) => { world.ran.push({ name, args }); return null; };
export const shared = (key) => (key === "layout" ? world.layoutName : undefined);
export const settings = () => ({ zoom: world.zoom });
export const theme = () => colours;`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs) return { url: `stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("stub:")) return { format: "module", source: stubs[url.slice(5)], shortCircuit: true };
    return next(url, context);
  },
});

// A cx whose sleeps never end, so the exec limit never wins a race. Timers are held, so a test runs them by hand.
export function fakeCx() {
  const tasks = [];
  const cx = {
    notified: 0, repeating: [],
    notify() { this.notified += 1; },
    sleep: () => new Promise(() => {}),
    spawn(body) { tasks.push(body(cx)); },
    timer: { every(ms, handler) { cx.repeating.push({ ms, handler }); } },
    // A task still waiting once everything ready has run, such as the overlay's wait for a command, is let go.
    settled: async () => { while (tasks.length) await Promise.race([tasks.shift(), new Promise((done) => setImmediate(done))]); },
  };
  return cx;
}
