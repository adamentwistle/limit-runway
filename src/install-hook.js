// `runway install-hook`. It shows the change first and writes only with --yes. Everything already in the file stays.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_TIMEOUT } from "./hook.js";
import { files } from "./paths.js";
import { configDir } from "./sources/login.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const isOurs = (hook) => /runway(\.js)?"?\s+hook\b/.test(String(hook?.command ?? ""));

// The project target is settings.local.json, which Claude Code keeps out of git, because the hook's path is this machine's.
export const targetPath = ({ project, user, env = process.env, cwd = process.cwd() }) => {
  if (user) return join(configDir(env), "settings.json");
  return join(project === true ? cwd : resolve(cwd, project), ".claude", "settings.local.json");
};

export const hookCommand = (script) => `node "${script.replace(/\\/g, "/")}" hook`;

export const hookEntry = (script) => ({
  matcher: "*",
  hooks: [{ type: "command", command: hookCommand(script), timeout: HOOK_TIMEOUT }],
});

export function withoutHook(settings) {
  const next = structuredClone(settings);
  const list = next.hooks?.PreToolUse;
  if (!Array.isArray(list)) return next;
  const kept = list
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !isOurs(hook)) }))
    .filter((group) => group.hooks.length);
  if (kept.length) next.hooks.PreToolUse = kept;
  else delete next.hooks.PreToolUse;
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function withHook(settings, script) {
  const next = withoutHook(settings);
  next.hooks ??= {};
  next.hooks.PreToolUse ??= [];
  next.hooks.PreToolUse.push(hookEntry(script));
  return next;
}

// Lines added and taken away, by longest common run. Settings files are short.
export function diffLines(before, after) {
  const a = before ? before.split("\n") : [], b = after.split("\n");
  const best = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) best[i][j] = a[i] === b[j] ? best[i + 1][j + 1] + 1 : Math.max(best[i + 1][j], best[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < b.length && (i >= a.length || best[i][j + 1] >= best[i + 1][j])) { out.push(`+ ${b[j]}`); j++; }
    else { out.push(`- ${a[i]}`); i++; }
  }
  return out.join("\n");
}

// The script the hook will run. A copy made by npx can vanish with its cache, so in that case the tool is copied into the
// state folder and the hook runs that.
export function stableScript(paths, source = packageRoot, write = true) {
  const here = join(source, "bin", "runway.js");
  if (!/[\\/]_npx[\\/]/.test(source)) return here;
  const app = join(paths.dir, "app");
  if (write) {
    mkdirSync(app, { recursive: true });
    for (const name of ["bin", "src", "package.json"]) cpSync(join(source, name), join(app, name), { recursive: true });
  }
  return join(app, "bin", "runway.js");
}

export function planInstall({ project, user, remove = false, env = process.env, cwd = process.cwd(), paths = files(), source = packageRoot }) {
  if (!project && !user) return { error: "Say where: --project [folder] or --user." };
  const path = targetPath({ project, user, env, cwd });
  let settings = {}, before = "";
  if (existsSync(path)) {
    before = readFileSync(path, "utf8");
    try {
      settings = before.trim() ? JSON.parse(before) : {};
    } catch {
      return { error: `${path} isn't valid JSON. Nothing changed.` };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { error: `${path} isn't a settings object. Nothing changed.` };
  }
  const next = remove ? withoutHook(settings) : withHook(settings, stableScript(paths, source, false));
  const after = `${JSON.stringify(next, null, 2)}\n`;
  const same = JSON.stringify(settings) === JSON.stringify(next);
  return { path, before, after, same, diff: diffLines(before.trimEnd(), after.trimEnd()), source, paths, remove };
}

export function applyInstall(plan) {
  if (!plan.remove) stableScript(plan.paths, plan.source, true);
  mkdirSync(dirname(plan.path), { recursive: true });
  if (plan.before) writeFileSync(`${plan.path}.before-runway`, plan.before);
  writeFileSync(plan.path, plan.after);
}
