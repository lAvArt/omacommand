// Spec 11, test 8: every command is an argv array with a known first element, and a folder only ever appears in a safe place.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness, mulberry32, randomPlan } from "./helpers.mjs";

const { V } = makeHarness();

// The fixed first elements. Spotify is started through uwsm-app, never through Omarchy's own launcher for it (review C3), and
// the volume, brightness and music steps are exactly the commands of Omarchy 4.0.4's own keys (review C4).
const HEADS = new Set([
  "uwsm-app", "omarchy-launch-browser", "omarchy-launch-terminal", "omarchy-launch-nautilus",
  "omarchy-launch-tui", "omarchy-system-lock", "omarchy-toggle-nightlight", "omarchy-hyprland-window-gaps-toggle",
  "omarchy-hyprland-window-transparency-toggle", "omarchy-hyprland-window-pop", "omarchy-hyprland-workspace-layout-toggle",
  "omarchy-notification-time", "omarchy-notification-battery", "omarchy-shell", "omarchy-audio-output-volume",
  "omarchy-brightness-display"
]);

const REAL = "/home/u/zz-sentinel/prj-1";

function assertArgv(argv, label, folder) {
  assert.ok(Array.isArray(argv) && argv.length >= 1, label + ": an array");
  assert.ok(HEADS.has(argv[0]), label + ": unknown command " + argv[0]);
  for (const part of argv) {
    assert.equal(typeof part, "string", label);
    assert.ok(!/[\n\r\0]/.test(part), label + ": newline or NUL in " + JSON.stringify(part));
  }
  if (folder) {
    const holders = argv.map((p, i) => [p, i]).filter(([p]) => p.includes(folder));
    assert.equal(holders.length, 1, label + ": the folder appears " + holders.length + " times");
    const [p, i] = holders[0];
    assert.equal(i, argv.length - 1, label + ": the folder is not the last element");
    assert.ok(p === folder || p === "--dir=" + folder, label + ": the folder is mixed into " + p);
  } else {
    assert.ok(argv.every((p) => !p.includes("zz-sentinel")), label);
  }
  if (argv[0] === "uwsm-app") assert.equal(argv[1], "--", label + ": uwsm-app is followed by --");
}

function allSteps() {
  const steps = [];
  const spec = V.STEP_SPECS;
  for (const app of V.APP_KEYS) {
    steps.push({ do: "open", app });
    for (const place of ["left", "right", "up", "down"]) steps.push({ do: "open", app, place });
    if (V.APPS[app].folder) {
      steps.push({ do: "open", app, folder: "~/zz-sentinel/prj-1" });
      steps.push({ do: "open", app, folder: "zz-sentinel/prj-1", place: "right" });
    }
    steps.push({ do: "focus", app });
  }
  for (const what of spec.system.fields.what.values) steps.push({ do: "system", what });
  for (const what of spec.desktop.fields.what.values) steps.push({ do: "desktop", what });
  for (const what of spec.window.fields.what.values) steps.push({ do: "window", what });
  for (const mode of spec.layout.fields.mode.values) steps.push({ do: "layout", mode });
  steps.push({ do: "scratchpad" }, { do: "workspace", to: 4 }, { do: "swap", direction: "left" }, { do: "focus", direction: "up" });
  steps.push({ do: "move", to: 3, follow: true }, { do: "resize", change: "taller", amount: "huge" });
  return steps;
}

test("every step of the vocabulary yields only safe argv arrays", () => {
  let argvCount = 0;
  for (const step of allSteps()) {
    const verdict = V.validateStep(step, 1);
    assert.equal(verdict.ok, true, JSON.stringify(step) + " should be a valid step");
    const hasFolder = "folder" in step;
    const ops = V.planOps(step, hasFolder ? { folderReal: REAL } : {});
    for (const op of ops) {
      if (op.t === "exec" || op.t === "run" || op.t === "layout" || op.t === "open") {
        assertArgv(op.argv, JSON.stringify(step), hasFolder && op.t === "open" ? REAL : null);
        argvCount++;
      } else {
        assert.equal(op.argv, undefined, JSON.stringify(step) + ": a " + op.t + " op has no argv");
      }
    }
  }
  assert.ok(argvCount > 40);
});

test("apps start through uwsm-app or the launch scripts of Omarchy", () => {
  assert.deepEqual(Array.from(V.appArgv("vscode", "/home/u/Development/prj")), ["uwsm-app", "--", "code", "--new-window", "/home/u/Development/prj"]);
  assert.deepEqual(Array.from(V.appArgv("terminal", "/home/u/Development/prj")), ["uwsm-app", "--", "xdg-terminal-exec", "--dir=/home/u/Development/prj"]);
  assert.deepEqual(Array.from(V.appArgv("browser")), ["omarchy-launch-browser"]);
  assert.deepEqual(Array.from(V.appArgv("btop")), ["omarchy-launch-tui", "btop"]);
});

test("Spotify starts through uwsm-app, and Omarchy's own launcher for it is never used (review C3)", () => {
  assert.deepEqual(Array.from(V.appArgv("spotify")), ["uwsm-app", "--", "spotify"]);
  assert.deepEqual(Array.from(V.SPOTIFY_CHECK), ["test", "-x", "/usr/bin/spotify"]);
  const launcher = "omarchy-launch-" + "spotify";
  const adder = "omarchy-install-" + "service-spotify";
  for (const step of [{ do: "open", app: "spotify" }, { do: "open", app: "spotify", place: "left" }]) {
    for (const op of V.planOps(step)) assert.ok(!op.argv.includes(launcher) && !op.argv.includes(adder));
  }
  const rnd = mulberry32(5);
  for (let n = 0; n < 3000; n++) {
    const r = V.validatePlan(randomPlan(rnd, V));
    if (!r.ok) continue;
    for (const step of r.plan.steps) {
      const hasFolder = "folder" in step;
      for (const op of V.planOps(step, hasFolder ? { folderReal: REAL } : {})) {
        if (op.argv) assert.ok(!op.argv.includes(launcher) && !op.argv.includes(adder), JSON.stringify(step));
      }
    }
  }
});

test("volume, brightness and music are exactly the commands of Omarchy 4.0.4's own keys, and they are waited for (review C4)", () => {
  const want = {
    volume_up: ["omarchy-audio-output-volume", "raise"],
    volume_down: ["omarchy-audio-output-volume", "lower"],
    mute: ["omarchy-audio-output-volume", "mute-toggle"],
    brightness_up: ["omarchy-brightness-display", "+5%"],
    brightness_down: ["omarchy-brightness-display", "5%-"],
    play_pause: ["omarchy-shell", "media", "playPause"],
    next_track: ["omarchy-shell", "media", "next"],
    previous_track: ["omarchy-shell", "media", "previous"]
  };
  for (const [what, argv] of Object.entries(want)) {
    const ops = V.planOps({ do: "system", what });
    assert.equal(ops.length, 1, what);
    assert.equal(ops[0].t, "run", what + " runs as the tracked process, so its exit code is known");
    assert.deepEqual(Array.from(ops[0].argv), argv, what);
  }
  // The rest is only started, as before.
  for (const what of ["lock", "show_time", "show_battery"]) assert.equal(V.planOps({ do: "system", what })[0].t, "exec", what);
  // None of the tools that a stock Omarchy 4.0.4 does not have.
  const gone = ["wpc" + "tl", "brightness" + "ctl", "player" + "ctl"];
  for (const what of V.STEP_SPECS.system.fields.what.values) {
    for (const part of V.planOps({ do: "system", what })[0].argv) assert.ok(!gone.includes(part), what + ": " + part);
  }
});

test("a folder that is not a safe absolute path is never put into a command", () => {
  for (const bad of ["relative", "~/x", "/home/u/../etc", "/home/u/x\ny", "/home/u/x\"y", "/home/u/x\\y", "", "//x", "/home/u//x", "-rf"]) {
    assert.throws(() => V.appArgv("terminal", bad), undefined, JSON.stringify(bad));
    assert.throws(() => V.appArgv("vscode", bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => V.appArgv("nope"), undefined, "an unknown app");
  assert.throws(() => V.appArgv("__proto__"), undefined, "a prototype name");
});

test("a step with a folder that was not resolved is never turned into a command", () => {
  assert.throws(() => V.planOps({ do: "open", app: "terminal", folder: "x" }, {}));
  assert.throws(() => V.planOps({ do: "open", app: "terminal", folder: "x" }, { folderReal: 5 }));
});

test("the argv tables are copied, so a caller cannot change them", () => {
  const a = V.planOps({ do: "system", what: "volume_up" })[0].argv;
  a.push("--evil");
  a[0] = "other";
  const b = V.planOps({ do: "system", what: "volume_up" })[0].argv;
  assert.equal(b[0], "omarchy-audio-output-volume");
  assert.ok(!b.includes("--evil"));
});

test("a window that is not the right kind cannot be a command: close has no argv, lua ops have no argv", () => {
  const close = V.planOps({ do: "window", what: "close", app: "vscode" })[0];
  assert.equal(close.t, "close");
  assert.equal(close.argv, undefined);
  for (const op of V.planOps({ do: "window", what: "float" })) {
    assert.equal(op.t, "lua");
    assert.equal(op.argv, undefined);
  }
});

test("random valid plans only ever produce known commands", () => {
  const rnd = mulberry32(31337);
  let checked = 0;
  for (let n = 0; n < 5000; n++) {
    const r = V.validatePlan(randomPlan(rnd, V));
    if (!r.ok) continue;
    for (const step of r.plan.steps) {
      const hasFolder = "folder" in step;
      for (const op of V.planOps(step, hasFolder ? { folderReal: REAL } : {})) {
        if (op.argv) {
          assertArgv(op.argv, JSON.stringify(step), hasFolder && op.t === "open" ? REAL : null);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 2000);
});

// ---------------------------------------------------------------- through the desk
// Proposes the steps, goes through the box with a click on Allow, and lets the run start.
function runOne(steps) {
  const h = makeHarness();
  const r = h.propose(steps);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.tick(200);
  return { h, r, status: () => h.status(r.id) };
}

test("a volume step is waited for: exit 0 is done, anything else is a failed step with a sentence (review C4)", () => {
  const good = runOne([{ do: "system", what: "volume_up" }, { do: "workspace", to: 2 }]);
  assert.deepEqual(Array.from(good.h.inflight), ["omarchy-audio-output-volume", "raise"]);
  assert.equal(good.h.execs.filter((a) => a[0] === "omarchy-audio-output-volume").length, 0, "not started detached");
  good.h.answer("", 0);
  good.h.runAll();
  assert.equal(good.status().state, "done");
  assert.equal(good.status().steps[0].note, "Turn the volume up: done");

  const bad = runOne([{ do: "system", what: "play_pause" }, { do: "workspace", to: 2 }]);
  assert.deepEqual(Array.from(bad.h.inflight), ["omarchy-shell", "media", "playPause"]);
  bad.h.answer("", 1);
  bad.h.runAll();
  const s = bad.status();
  assert.equal(s.state, "failed");
  assert.equal(s.message, "Step 1 failed: the command ended with an error. The steps after it did not run.");
  assert.equal(s.steps[0].ok, false);
  assert.ok(!bad.h.started.some((a) => a[0] === "hyprctl"), "step 2 did not run");
  assert.deepEqual(Array.from(bad.h.execs.at(-1)), ["notify-send", "-a", "Omacommand", "An AI agent's request stopped at step 1."]);

  // A command that never ends is stopped after its time and reported.
  const slow = runOne([{ do: "system", what: "brightness_up" }]);
  assert.deepEqual(Array.from(slow.h.inflight), ["omarchy-brightness-display", "+5%"]);
  slow.h.tick(6100);
  assert.deepEqual(slow.h.kills, [false]);
  const t = slow.status();
  assert.equal(t.state, "failed");
  assert.equal(t.message, "Step 1 failed: the command did not finish in time. The steps after it did not run.");
});

test("a command that could not be started (exit -1) is a failed step too, and the slot is free again afterwards (review C4, C7)", () => {
  const run = runOne([{ do: "system", what: "mute" }]);
  run.h.answer("", -1);
  run.h.runAll();
  assert.equal(run.status().state, "failed");
  run.h.tick(3000);
  assert.equal(run.h.propose([{ do: "workspace", to: 3 }]).ok, true);
  assert.deepEqual(Array.from(run.h.inflight), ["omarchy-shell", "lock", "isLocked"]);
});

test("two mute toggles in a row keep the pause between them (Omarchy ignores a second toggle within 250 ms)", () => {
  const run = runOne([{ do: "system", what: "mute" }, { do: "system", what: "mute" }]);
  run.h.answer("", 0);
  run.h.tick(300);
  assert.equal(run.h.started.filter((a) => a[0] === "omarchy-audio-output-volume").length, 1, "still in the pause");
  run.h.tick(500);
  run.h.answer("", 0);
  run.h.runAll();
  assert.equal(run.h.started.filter((a) => a[0] === "omarchy-audio-output-volume").length, 2);
  assert.equal(run.status().state, "done");
});

test("an open Spotify step needs /usr/bin/spotify: without it no box is shown, and no launcher is started (review C3)", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }, { do: "open", app: "spotify" }]);
  h.autoAnswer(); // the lock check
  assert.deepEqual(Array.from(h.inflight), ["test", "-x", "/usr/bin/spotify"]);
  h.answer("", 1);
  h.untilBox();
  assert.equal(h.shown.length, 0, "no box");
  const s = h.status(r.id);
  assert.equal(s.state, "refused");
  assert.equal(s.message, "Step 2: Spotify is not installed.");
  assert.equal(h.execs.length, 0);
  assert.ok(!h.started.some((a) => a.includes("omarchy-launch-" + "spotify")));

  const ok = makeHarness();
  ok.propose([{ do: "open", app: "spotify" }]);
  ok.untilBox();
  assert.equal(ok.shown.length, 1, "with the app there, the box is shown");
  ok.drawBox();
  ok.clickAllow();
  ok.tick(300);
  assert.deepEqual(Array.from(ok.execs.at(-1)), ["uwsm-app", "--", "spotify"]);

  // A plan without a Spotify step never runs the check.
  const none = makeHarness();
  none.propose([{ do: "open", app: "btop" }]);
  none.untilBox();
  assert.ok(!none.started.some((a) => a[0] === "test" && a[1] === "-x"));
});
