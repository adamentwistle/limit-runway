// House rules for the package itself.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root } from "./helpers.mjs";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if ([".git", "node_modules", "jsconfig.json"].includes(name) || name.endsWith(".d.ts")) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("no runtime dependencies, ESM, and the runway command", () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin.runway, "bin/runway.js");
  assert.equal(pkg.license, "MIT");
});

test("only node: built-ins are imported in src", () => {
  for (const path of walk(join(root, "src"))) {
    for (const [, name] of readFileSync(path, "utf8").matchAll(/from "([^"]+)"/g)) assert.match(name, /^(node:|\.)/, `${path}: ${name}`);
  }
});

test("the panel opens by a key on any layout, and docks on a personal one", () => {
  const mod = JSON.parse(readFileSync(join(root, "herdr", "mods", "runway", "mod.json"), "utf8"));
  assert.equal(mod.place, "right");
  assert.ok(mod.overlay.width > 0);
  const keys = JSON.parse(readFileSync(join(root, "herdr", "keys.json"), "utf8"));
  assert.equal(keys.global["ctrl-shift-m"], "mod.open:runway");
});

test("no em dashes in the text", () => {
  const dash = String.fromCharCode(0x2014);
  for (const path of walk(root).filter((p) => /\.(md|js|mjs|json)$/.test(p))) assert.ok(!readFileSync(path, "utf8").includes(dash), path);
});
