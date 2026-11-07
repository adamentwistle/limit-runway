// The Runway panel. It reads the CLI and shows what it says. The only things it starts are a press on Pause or Resume, and
// finishing a pause whose time is up. Opened as an overlay it also has Pin to sidebar, which only changes the layout.
import { View } from "gpui-kit";
import { exec, layout, nextCommand, props, run, shared, theme } from "herdr";
import { platform } from "os";
import { demoReply } from "./demo.js";
import { commandNames, pauseArgs, readReply, resumeArgs, statusArgs, watchStartArgs } from "./logic.js";
import { pinPlan } from "./pin.js";
import { panel, prepare } from "./view.js";

const REFRESH_MS = 60000;
const EXEC_LIMIT_MS = 28000;

export default class Runway extends View {
  init(initial, cx) {
    this.reply = null;
    this.problem = null;
    this.missing = false;
    this.busy = null;
    this.running = false;
    this.program = null;
    const given = initial ?? props() ?? {};
    this.demo = given.demo ? { scene: given.demo === true || given.demo === "confirm" || given.demo === "menu" ? "watching" : given.demo } : null;
    this.confirming = given.demo === "confirm";
    this.menuOpen = given.demo === "menu";
    this.menuConfirm = null;
    this.size = null;
    this.plot = null;
    this.paths = {};
    this.overlay = given.overlay ?? null;
    this.names = given.command ? [given.command] : commandNames(/^win/i.test(String(platform())));
    // A key can press it: "runway.pin" reaches the open overlay, and "runway.menu" opens or closes the menu.
    if (this.overlay != null) {
      cx.spawn(async (cx) => {
        while (!this.closed) {
          const command = await nextCommand();
          if (command === "pin") this.pin(cx);
          if (command === "menu") this.toggleMenu(cx);
        }
      });
    }
    if (this.demo) {
      this.reply = demoReply(Date.now(), this.demo.scene);
      return;
    }
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  // Runs the CLI, trying each name it could have. `exec` rejects when a program can't start, and stops at 30 s.
  async runway(args, cx) {
    const names = this.program ? [this.program] : this.names;
    for (const name of names) {
      try {
        const result = await Promise.race([
          exec(name, args),
          cx.sleep(EXEC_LIMIT_MS).then(() => ({ code: -1, stdout: "", stderr: "runway took too long" })),
        ]);
        this.program = name;
        this.missing = false;
        return readReply(result);
      } catch {
        // Not this name. Try the next.
      }
    }
    this.program = null;
    this.missing = true;
    return { problem: null };
  }

  refresh(cx) {
    if (this.running || this.busy) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        let { reply, problem } = await this.runway(statusArgs(), cx);
        if (reply?.due) {
          await this.runway(resumeArgs(true), cx);
          ({ reply, problem } = await this.runway(statusArgs(), cx));
        }
        if (reply) this.reply = reply;
        this.problem = problem ?? null;
      } finally {
        this.running = false;
        cx.notify();
      }
    });
  }

  press(cx) {
    if (this.busy) return;
    const resuming = Boolean(this.reply?.pause);
    if (!resuming && !this.confirming) {
      this.confirming = true;
      cx.notify();
      return;
    }
    this.confirming = false;
    if (this.demo) {
      this.demo.scene = resuming ? "watching" : "paused";
      this.reply = demoReply(Date.now(), this.demo.scene);
      cx.notify();
      return;
    }
    this.busy = resuming ? "resume" : "pause";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { problem } = await this.runway(resuming ? resumeArgs() : pauseArgs(), cx);
        this.problem = problem ?? null;
      } finally {
        this.busy = null;
        cx.notify();
      }
      this.refresh(cx);
    });
  }

  // Read live on every render, so a hide from anywhere else shows here too.
  pinning() {
    if (this.overlay == null) return null;
    return pinPlan(layout(), shared("layout"));
  }

  pin(cx) {
    const plan = this.pinning();
    if (!plan) return;
    for (const [name, args] of plan.commands) run(name, args);
    cx.notify();
  }

  close() {
    this.closed = true;
  }

  toggleMenu(cx) {
    this.menuOpen = !this.menuOpen;
    this.menuConfirm = null;
    cx.notify();
  }

  // A menu item. One that can pause agents asks first: its press shows Cancel and its confirm word, and only that runs it.
  choose(item, cx, confirmed = false) {
    if (this.busy) return;
    if (item.confirm && !confirmed) {
      this.menuConfirm = item.id;
      cx.notify();
      return;
    }
    this.menuOpen = false;
    this.menuConfirm = null;
    if (this.demo) {
      cx.notify();
      return;
    }
    this.busy = "menu";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { problem } = item.run.watcher ? await this.startWatcher(cx) : await this.runway(item.run.cli, cx);
        this.problem = problem ?? null;
      } finally {
        this.busy = null;
        cx.notify();
      }
      this.refresh(cx);
    });
  }

  // `runway watch --act` outlives `exec`'s 30 s, so hc starts it in a terminal of its own.
  async startWatcher(cx) {
    try {
      const result = await Promise.race([
        exec("hc", watchStartArgs(this.program ?? this.names.at(-1))),
        cx.sleep(EXEC_LIMIT_MS).then(() => ({ code: -1, stdout: "", stderr: "hc took too long" })),
      ]);
      return result.code === 0 ? {} : { problem: String(result.stderr || "hc couldn't start the watcher").trim().split("\n")[0] };
    } catch {
      return { problem: "hc isn't installed, so the watcher can't start here. Run runway watch --act --herdr in a terminal." };
    }
  }

  cancelMenu(cx) {
    this.menuConfirm = null;
    cx.notify();
  }

  cancel(cx) {
    this.confirming = false;
    cx.notify();
  }

  // The panel's size picks the layout. The scene's own size, which the flex layout decides, sets its paths. Both are kept as
  // measured, in window pixels, and the view turns them into the app's own at the zoom of the moment.
  sized(size, cx) {
    this.size = size;
    cx.notify();
  }

  chartSized(size, cx) {
    this.plot = size;
    prepare(this);
    cx.notify();
  }

  render() {
    return panel(this, theme());
  }
}
