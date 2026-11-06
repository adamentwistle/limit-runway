// Every test works in a throwaway home. Nothing here can reach a real login, a real Herdr or the real endpoint: HOME and the
// config folders are temporary, `hc` is the fake in tests/fakes, and the endpoint is switched off unless a test passes its own.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const bin = join(root, "bin", "runway.js");
const fakeHc = join(root, "tests", "fakes", "hc.mjs");

export function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), "runway-test-"));
  t?.after(() => rmSync(home, { recursive: true, force: true }));
  const state = join(home, "state");
  const hcLog = join(home, "hc.log");
  const hcList = join(home, "hc-ls.json");
  writeFileSync(hcList, JSON.stringify({ terminals: [] }));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    RUNWAY_HOME: state,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    RUNWAY_NO_ENDPOINT: "1",
    RUNWAY_HC_ARGV: JSON.stringify([process.execPath, fakeHc]),
    FAKE_HC_LOG: hcLog,
    FAKE_HC_LIST: hcList,
  };
  const paths = {
    dir: state, config: join(state, "config.json"), pause: join(state, "pause.json"), history: join(state, "history.jsonl"),
    endpoint: join(state, "endpoint.json"), overrides: join(state, "overrides.json"), held: join(state, "held"), watchLock: join(state, "watch.lock"), log: join(state, "events.log"),
  };
  return {
    home, state, env, paths,
    hcCalls() {
      try {
        return readFileSync(hcLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    terminals(list) { writeFileSync(hcList, JSON.stringify({ terminals: list })); },
    cache(name, value) {
      const folder = join(home, ".cache", name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "usage.json"), JSON.stringify(value));
    },
    writeState(name, value) {
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, name), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

export function run(args, env, { input = "", cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export const minutes = (n) => n * 60000;
export const iso = (ms) => new Date(ms).toISOString();
