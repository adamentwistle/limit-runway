// A stand-in for `hc`. It writes down what it was asked and answers `ls` from a file. Nothing here can reach a real terminal.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_HC_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === "ls") process.stdout.write(readFileSync(process.env.FAKE_HC_LIST, "utf8"));
else if (args[0] === "interrupt") process.stdout.write(JSON.stringify({ ok: true, effect: "stopped" }));
else if (args[0] === "send" && args[1] === "fail") process.exit(1);
