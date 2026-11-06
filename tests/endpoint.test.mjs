// The login path, against a local fake server. The real endpoint is never called: every request here goes to 127.0.0.1.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { ENDPOINT, outcome, readEndpoint, requestUsage, retryAfter, waitFor } from "../src/sources/endpoint.js";
import { keychainAccount, readLogin, serviceNames, tokenFrom } from "../src/sources/login.js";
import { root, sandbox } from "./helpers.mjs";

const TOKEN = "made-up-login.0123456789";
const GOOD = JSON.stringify({ five_hour: { utilization: 29, resets_at: "2030-01-01T10:00:00Z" }, seven_day: { utilization: 40, resets_at: "2030-01-03T10:00:00Z" } });

async function fakeServer(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { seen, target: `http://127.0.0.1:${server.address().port}/api/oauth/usage` };
}

const credentials = (box, value) => {
  mkdirSync(box.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(join(box.env.CLAUDE_CONFIG_DIR, ".credentials.json"), typeof value === "string" ? value : JSON.stringify(value));
};

test("the address is the one constant, and only Anthropic's", () => {
  assert.equal(ENDPOINT, "https://api.anthropic.com/api/oauth/usage");
  const code = readFileSync(join(root, "src", "sources", "endpoint.js"), "utf8");
  assert.equal(code.match(/https:\/\//g).length, 1);
  assert.doesNotMatch(code, /env\.[A-Z_]*(URL|HOST|ENDPOINT)/);
});

test("a good answer gives limits, with the headers the endpoint expects", async (t) => {
  const box = sandbox(t);
  credentials(box, { claudeAiOauth: { accessToken: TOKEN, refreshToken: "never-used" } });
  const server = await fakeServer(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(GOOD); });
  const reply = await readEndpoint({ paths: box.paths, env: box.env, target: server.target, now: Date.UTC(2029, 0, 1) });
  assert.equal(reply.status, "ok");
  assert.deepEqual(reply.limits.map((l) => [l.id, l.used]), [["claude.session", 29], ["claude.weekly", 40]]);
  const [request] = server.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/api/oauth/usage");
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.match(request.headers["user-agent"], /^limit-runway\//);
});

test("the login ends up in no file and no state", async (t) => {
  const box = sandbox(t);
  credentials(box, { claudeAiOauth: { accessToken: TOKEN } });
  const server = await fakeServer(t, (_req, res) => { res.writeHead(200); res.end(GOOD); });
  const reply = await readEndpoint({ paths: box.paths, env: box.env, target: server.target });
  assert.ok(!JSON.stringify(reply).includes(TOKEN));
  for (const name of readdirSync(box.state)) assert.ok(!readFileSync(join(box.state, name), "utf8").includes(TOKEN), name);
});

test("it waits five minutes between requests", async (t) => {
  const box = sandbox(t);
  credentials(box, { claudeAiOauth: { accessToken: TOKEN } });
  const server = await fakeServer(t, (_req, res) => { res.writeHead(200); res.end(GOOD); });
  const now = Date.UTC(2029, 0, 1);
  await readEndpoint({ paths: box.paths, env: box.env, target: server.target, now });
  const second = await readEndpoint({ paths: box.paths, env: box.env, target: server.target, now: now + 60000 });
  assert.equal(second.status, "waiting");
  assert.equal(server.seen.length, 1);
  await readEndpoint({ paths: box.paths, env: box.env, target: server.target, now: now + 301000 });
  assert.equal(server.seen.length, 2);
});

test("a redirect is never followed", async (t) => {
  const box = sandbox(t);
  credentials(box, { claudeAiOauth: { accessToken: TOKEN } });
  const elsewhere = await fakeServer(t, (_req, res) => { res.writeHead(200); res.end(GOOD); });
  const server = await fakeServer(t, (_req, res) => { res.writeHead(302, { location: elsewhere.target }); res.end(); });
  const reply = await readEndpoint({ paths: box.paths, env: box.env, target: server.target });
  assert.equal(reply.status, "endpoint-changed");
  assert.equal(elsewhere.seen.length, 0);
});

test("each answer maps to its status", async (t) => {
  const answers = [[401, "login-expired"], [403, "login-expired"], [429, "rate-limited"], [500, "offline"], [404, "endpoint-changed"]];
  for (const [code, status] of answers) {
    const box = sandbox(t);
    credentials(box, { claudeAiOauth: { accessToken: TOKEN } });
    const server = await fakeServer(t, (_req, res) => { res.writeHead(code, code === 429 ? { "retry-after": "120" } : {}); res.end("{}"); });
    const now = Date.UTC(2029, 0, 1);
    const reply = await readEndpoint({ paths: box.paths, env: box.env, target: server.target, now });
    assert.equal(reply.status, status);
    const state = JSON.parse(readFileSync(box.paths.endpoint, "utf8"));
    assert.equal(state.status, status);
    assert.equal(state.http, code);
    if (code === 429) assert.equal(state.nextAt, new Date(now + 120000).toISOString());
  }
});

test("a server that isn't there is offline, and the error's text goes nowhere", async () => {
  const reply = await requestUsage(TOKEN, "http://127.0.0.1:9/api/oauth/usage");
  assert.deepEqual(reply, { code: null, headers: {}, body: "" });
  assert.equal(outcome(null, {}, "", 0).status, "offline");
});

test("Retry-After in seconds and as a date, and the backoff", () => {
  assert.equal(retryAfter("120", 0), 120);
  assert.equal(retryAfter("Thu, 01 Jan 1970 00:02:00 GMT", 0), 120);
  assert.equal(retryAfter("nonsense", 0), null);
  assert.equal(waitFor("ok", 0), 300);
  assert.equal(waitFor("offline", 1), 300);
  assert.equal(waitFor("offline", 2), 600);
  assert.equal(waitFor("offline", 9), 3600);
  assert.equal(waitFor("login-expired", 1), 900);
  assert.equal(waitFor("no-login", 1), 3600);
  assert.equal(waitFor("rate-limited", 1, 99999), 3600);
});

test("Windows and Linux read .credentials.json in the config folder", async (t) => {
  const box = sandbox(t);
  assert.equal((await readLogin({ env: box.env, system: "win32" })).status, "no-login");
  credentials(box, { claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 100000 } });
  assert.deepEqual(await readLogin({ env: box.env, system: "win32" }), { status: "ok", token: TOKEN });
  assert.deepEqual(await readLogin({ env: box.env, system: "linux" }), { status: "ok", token: TOKEN });
});

test("an expired login isn't sent", async (t) => {
  const box = sandbox(t);
  credentials(box, { claudeAiOauth: { accessToken: TOKEN, expiresAt: 1000 } });
  const server = await fakeServer(t, (_req, res) => { res.writeHead(200); res.end(GOOD); });
  const reply = await readEndpoint({ paths: box.paths, env: box.env, target: server.target });
  assert.equal(reply.status, "login-expired");
  assert.equal(server.seen.length, 0);
});

test("a bad credentials file is no login", (t) => {
  assert.equal(tokenFrom("not json").status, "no-login");
  assert.equal(tokenFrom("{}").status, "no-login");
  assert.equal(tokenFrom(JSON.stringify({ claudeAiOauth: { accessToken: "has spaces" } })).status, "no-login");
});

test("macOS asks for the one named keychain entry and nothing else", async () => {
  const asked = [];
  const keychain = async (service, account) => {
    asked.push([service, account]);
    return { code: 0, value: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }) };
  };
  const reply = await readLogin({ env: { USER: "person", HOME: "/h" }, system: "darwin", keychain });
  assert.deepEqual(reply, { status: "ok", token: TOKEN });
  assert.deepEqual(asked, [["Claude Code-credentials", "person"]]);
});

test("macOS keychain names: a suffix for a profile, and the plain name for ~/.claude too", () => {
  assert.deepEqual(serviceNames({}), ["Claude Code-credentials"]);
  const [suffixed] = serviceNames({ CLAUDE_CONFIG_DIR: "/h/.other", HOME: "/h" });
  assert.match(suffixed, /^Claude Code-credentials-[0-9a-f]{8}$/);
  assert.equal(serviceNames({ CLAUDE_CONFIG_DIR: "/h/.other", HOME: "/h" }).length, 1);
  assert.equal(keychainAccount({ USER: "odd name!" }), "claude-code-user");
});

test("macOS keychain exit codes", async () => {
  const code = (value) => async () => ({ code: value, value: "" });
  assert.equal((await readLogin({ env: { USER: "p" }, system: "darwin", keychain: code(44) })).status, "no-login");
  assert.equal((await readLogin({ env: { USER: "p" }, system: "darwin", keychain: code(36) })).status, "keychain-locked");
  assert.equal((await readLogin({ env: { USER: "p" }, system: "darwin", keychain: code(51) })).status, "keychain-denied");
  const hex = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })).toString("hex");
  assert.equal(tokenFrom(hex).token, TOKEN);
});
