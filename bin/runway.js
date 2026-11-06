#!/usr/bin/env node
// The hook runs on every tool call, so it loads nothing it doesn't need.
const args = process.argv.slice(2);
if (args[0] === "hook") {
  let code = 0;
  try {
    const { runHook } = await import("../src/hook.js");
    code = await runHook({ args: args.slice(1) });
  } catch {
    code = 0;
  }
  process.exit(code);
}
const { main } = await import("../src/cli.js");
process.exitCode = await main(args);
