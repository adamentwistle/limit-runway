// Claude Code's own login, for reading the usage endpoint. It's held for one request and goes nowhere else. Nothing here
// logs it, prints it or writes it, and it is never refreshed: Claude Code does that when it runs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const SERVICE = "Claude Code-credentials";
const SECURITY = "/usr/bin/security";
const LOGIN_OK = /^[A-Za-z0-9._~+/=-]+$/;
const ACCOUNT_OK = /^[a-zA-Z0-9._-]+$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(env.HOME || env.USERPROFILE || homedir(), ".claude");

// Takes the access token out of Claude Code's JSON, and drops the rest at once.
export function tokenFrom(text, now = Date.now()) {
  let value = String(text ?? "").trim();
  if (HEX.test(value)) value = Buffer.from(value, "hex").toString("utf8");
  let oauth;
  try {
    oauth = JSON.parse(value)?.claudeAiOauth;
  } catch {
    return { status: "no-login" };
  }
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !LOGIN_OK.test(token)) return { status: "no-login" };
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return { status: "login-expired" };
  return { status: "ok", token };
}

const suffixed = (dir) => `${SERVICE}-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`;

// The ~/.claude-* folders, which are the other profiles Claude Code may be run with through CLAUDE_CONFIG_DIR.
export function knownProfiles(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".claude-"))
      .map((entry) => join(home, entry.name))
      .sort();
  } catch {
    return [];
  }
}

// macOS: the keychain names Claude Code uses, in the order to try them. No other entry is ever read. With CLAUDE_CONFIG_DIR
// set, it's that profile's entry. Without it, as when Herdr or another app starts runway without the shell's settings, it's
// the plain name first and then each ~/.claude-* profile's.
export function serviceNames(env = process.env) {
  const profile = env.CLAUDE_CONFIG_DIR;
  if (!profile) return [SERVICE, ...knownProfiles(env).map(suffixed)];
  const names = [suffixed(profile)];
  if (profile.normalize("NFC") === join(env.HOME || homedir(), ".claude")) names.push(SERVICE);
  return names;
}

export function keychainAccount(env = process.env) {
  let name = env.USER;
  if (!name) {
    try {
      name = userInfo().username;
    } catch {
      name = "";
    }
  }
  return ACCOUNT_OK.test(name ?? "") ? name : "claude-code-user";
}

const readKeychain = (service, account) => new Promise((resolve) => {
  execFile(SECURITY, ["find-generic-password", "-a", account, "-s", service, "-w"], { timeout: 10000, windowsHide: true }, (error, stdout) => {
    if (!error) return resolve({ code: 0, value: stdout });
    resolve({ code: error.killed ? 36 : typeof error.code === "number" ? error.code : 1, value: "" });
  });
});

export async function readLogin({ env = process.env, system = platform(), keychain = readKeychain, now = Date.now() } = {}) {
  if (system === "darwin") {
    for (const name of serviceNames(env)) {
      const { code, value } = await keychain(name, keychainAccount(env));
      if (code === 44) continue;
      if (code === 36) return { status: "keychain-locked" };
      if (code !== 0) return { status: "keychain-denied" };
      return tokenFrom(value, now);
    }
    return { status: "no-login" };
  }
  try {
    return tokenFrom(readFileSync(join(configDir(env), ".credentials.json"), "utf8"), now);
  } catch {
    return { status: "no-login" };
  }
}
