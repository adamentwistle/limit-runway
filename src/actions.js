// Pausing and resuming. The pause file is written first and removed first, so the hook follows at once whatever happens
// to Herdr or to a person's command after it.
import { spawn } from "node:child_process";
import { appendLine, ensureDir, files, writeJsonAtomic } from "./paths.js";
import { hookedFor, interruptAll, listTerminals, pickTargets, sendAll } from "./herdr.js";
import { claimPause, PROVIDERS, readOverrides, readPause, writePause } from "./pause.js";

const event = (paths, kind, details) => {
  try {
    ensureDir(paths.dir);
    appendLine(paths.log, { at: new Date().toISOString(), event: kind, ...details });
  } catch {
    // The log is a convenience.
  }
};

export const runCommand = (command, env) => new Promise((resolve) => {
  const child = spawn(command, { shell: true, env, stdio: "ignore", windowsHide: true, timeout: 60000 });
  child.on("error", () => resolve({ ok: false }));
  child.on("close", (code) => resolve({ ok: code === 0, code }));
});

const commandEnv = (env, pause) => ({
  ...env,
  RUNWAY_REASON: pause.reason ?? "",
  RUNWAY_UNTIL: pause.until ?? "",
  RUNWAY_LIMITS: (pause.limits ?? []).join(","),
  RUNWAY_PROVIDERS: (pause.providers ?? []).join(","),
});

/**
 * @param request { by, reason, providers (null: every plan and every agent), until, limits, resets, onResume }
 * @param options { herdr, machines, onPause, config, env, paths, now }
 */
export async function pauseNow(request, { herdr = false, machines, onPause, config, env = process.env, paths = files(), now = Date.now() } = {}) {
  const pause = {
    version: 1,
    by: request.by,
    reason: request.reason,
    limits: request.limits ?? [],
    resets: request.resets ?? {},
    providers: request.providers ?? PROVIDERS,
    since: new Date(now).toISOString(),
    until: request.until ?? null,
    resumeLine: config.resumeLine,
    onResume: request.onResume ?? null,
    herdr: [],
  };
  writePause(pause, paths);
  event(paths, "pause", { by: pause.by, reason: pause.reason, until: pause.until });

  const report = { paused: true, pause, interrupted: [], herdrError: null, onPause: null };
  if (herdr) {
    const listed = await listTerminals({ env });
    if (!listed.ok) {
      report.herdrError = listed.missing ? "hc not found" : "hc ls failed";
    } else {
      const targets = pickTargets(listed.terminals, {
        providers: request.providers ?? null,
        self: env.HC_TERMINAL_ID ?? null,
        machines: machines ?? config.herdr.machines,
        skipHooked: config.herdr.skipHooked,
        hooked: (cwd) => hookedFor(cwd, env),
      });
      report.interrupted = await interruptAll(targets, { env });
      const current = readPause(paths);
      if (current && !current.broken) {
        current.herdr = report.interrupted.filter((t) => t.ok).map(({ address, agent }) => ({ address, agent }));
        writePause(current, paths);
        report.pause = current;
      }
    }
  }
  if (onPause) {
    report.onPause = await runCommand(onPause, commandEnv(env, pause));
    event(paths, "on-pause", { ok: report.onPause.ok });
  }
  return report;
}

// Releases everything. Never fails to: the file goes first, and what comes after only reports.
export async function resumeNow({ manual = true, config, env = process.env, paths = files(), onResume } = {}) {
  const pause = claimPause(paths);
  if (!pause) return { resumed: false, sent: [], onResume: null };
  event(paths, "resume", { manual, reason: pause.reason ?? null });

  if (manual && pause.resets) {
    // Someone chose to carry on: watch mustn't pause again for the same limit in the same window.
    try {
      ensureDir(paths.dir);
      writeJsonAtomic(paths.overrides, { ...readOverrides(paths), ...pause.resets });
    } catch {
      // Watch would pause again, which a second resume answers. The release itself is done.
    }
  }

  const report = { resumed: true, pause, sent: [], onResume: null };
  if (pause.herdr?.length) report.sent = await sendAll(pause.herdr, pause.resumeLine ?? config?.resumeLine, { env });
  const command = onResume ?? pause.onResume;
  if (command) {
    report.onResume = await runCommand(command, commandEnv(env, pause));
    event(paths, "on-resume", { ok: report.onResume.ok });
  }
  return report;
}
