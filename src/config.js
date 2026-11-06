// Settings, from <state>/config.json over these defaults. Flags win over both.
import { ensureDir, files, readJson, writeJsonAtomic } from "./paths.js";
import { DEFAULT_RULES } from "./rules.js";

export const DEFAULTS = {
  ...DEFAULT_RULES,
  intervalSeconds: 60,
  minSamples: 3,
  minSpanMinutes: 10,
  resumeLine: "Your plan limit has reset. Carry on from where you stopped.",
  onPause: null,
  onResume: null,
  sources: { orchi: true, ccstatusline: true, endpoint: null, codex: true }, // endpoint: null means not asked yet
  herdr: { machines: false, skipHooked: true },
  limits: {},
};

export function loadConfig(paths = files()) {
  const saved = readJson(paths.config) ?? {};
  return {
    ...DEFAULTS,
    ...saved,
    sources: { ...DEFAULTS.sources, ...(saved.sources ?? {}) },
    herdr: { ...DEFAULTS.herdr, ...(saved.herdr ?? {}) },
    limits: { ...(saved.limits ?? {}) },
  };
}

// Saves the answer on using the Claude login, keeping everything else in the file.
export function saveLoginChoice(allowed, paths = files()) {
  ensureDir(paths.dir);
  const saved = readJson(paths.config) ?? {};
  writeJsonAtomic(paths.config, { ...saved, sources: { ...(saved.sources ?? {}), endpoint: allowed } });
}
