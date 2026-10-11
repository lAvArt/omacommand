// The life of one request in the desk, with fake ports: preparation, the box, the run, the log, the welcome note.
// These are not numbered in spec 11, but they hold the other tests together (and test 4's "busy").
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness, win } from "./helpers.mjs";

const VSCODE = "com.microsoft.VSCode";

function notes(status) {
  return Array.from(status.steps, (s) => s.note);
}

test("a plain run: workspace, then done, with a note per step and one notification", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }, { do: "scratchpad" }]);
  assert.equal(h.status(r.id).state, "pending");
  h.untilBox();
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].screen, "eDP-1");
  assert.equal(h.shown[0].content.title, "An AI agent on this computer wants to:");
  assert.deepEqual(Array.from(h.shown[0].content.lines, (l) => l.text), ["1. Go to workspace 2", "2. Show or hide the scratchpad"]);
  assert.equal(h.shown[0].content.footer, "Nothing runs until you click Allow. Esc or Deny means no.");
  assert.equal(h.shown[0].content.note, "");
  h.drawBox();
  h.clickAllow();
  assert.equal(h.status(r.id).state, "running");
  const before = h.started.length;
  h.tick(100);
  assert.equal(h.started.length, before, "the run starts 150 ms after the box closes");
  h.tick(60);
  assert.equal(h.inflight[0], "hyprctl");
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "done");
  assert.equal(s.message, "The person allowed it. All 2 steps ran.");
  assert.deepEqual(notes(s), ["Go to workspace 2: done", "Show or hide the scratchpad: done"]);
  const dispatches = h.started.filter((a) => a[0] === "hyprctl").map((a) => Array.from(a));
  assert.deepEqual(dispatches, [
    ["hyprctl", "-i", "0", "dispatch", 'hl.dsp.focus({ workspace = "2" })'],
    ["hyprctl", "-i", "0", "dispatch", 'hl.dsp.workspace.toggle_special("scratchpad")']
  ]);
  const notifications = h.execs.filter((a) => a[0] === "notify-send");
  assert.equal(notifications.length, 1);
  assert.deepEqual(Array.from(notifications[0]), ["notify-send", "-a", "Omacommand", "An AI agent's request ran (2 steps)."]);
});

test("Deny, Esc, and the click on Allow reach the right final state", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.untilBox();
  h.drawBox();
  h.desk.box.key("escape", false, h.now);
  const s = h.status(r.id);
  assert.equal(s.state, "denied");
  assert.equal(s.message, "The person said no. Nothing ran.");
  assert.equal(h.execs.length, 0, "no notification for a no");
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});

test("an app opens when its window shows up; the plan remembers the window", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "open", app: "vscode", place: "right" }, { do: "window", what: "float", app: "vscode" }]);
  h.untilBox();
  assert.equal(h.shown[0].content.lines[0].text, "1. Open VS Code to the right of the current window");
  h.drawBox();
  h.clickAllow();
  h.tick(200);
  assert.deepEqual(Array.from(h.inflight), ["hyprctl", "-i", "0", "dispatch", 'hl.dsp.layout("preselect r")']);
  h.answer("ok\n", 0);
  assert.deepEqual(Array.from(h.execs.at(-1)), ["uwsm-app", "--", "code", "--new-window"]);
  h.tick(1000);
  assert.equal(h.status(r.id).state, "running", "still waiting for the window");
  // The window appears: Hyprland names it with an openwindow event (addresses come without 0x).
  h.snapshot.windows.push(win("0xc3", VSCODE, { pid: 333, stableId: "s-333", workspaceId: 1 }));
  h.desk.hyprEvent("openwindow", "c3,1," + VSCODE + ",Some title", h.now);
  h.tick(800);
  assert.equal(h.inflight[0], "hyprctl", "the next step float is being sent");
  assert.equal(h.inflight[4], 'hl.dsp.window.float({ action = "toggle", window = "address:0xc3" })');
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "done");
  assert.deepEqual(notes(s), ["Open VS Code to the right of the current window: done", "Toggle floating for the VS Code window: done"]);
});

test("an app that never shows a window fails after 30 s", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "open", app: "spotify" }, { do: "workspace", to: 3 }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  for (let i = 0; i < 320; i++) h.tick(100);
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.equal(s.message, "Step 1 failed: the app did not open in time. The steps after it did not run.");
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"), "step 2 did not run");
  assert.deepEqual(Array.from(h.execs.at(-1)), ["notify-send", "-a", "Omacommand", "An AI agent's request stopped at step 1."]);
});

test("an app that is already open is switched to, not started again", () => {
  const h = makeHarness();
  h.snapshot.windows.push(win("0xc3", VSCODE, { pid: 333, stableId: "s-333", focusHistoryID: 3 }));
  const r = h.propose([{ do: "open", app: "vscode" }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "done");
  assert.equal(notes(s)[0], "Open VS Code: done (it was already open, so it switched to it)");
  assert.ok(!h.execs.some((a) => a[0] === "uwsm-app"));
  assert.equal(h.started.filter((a) => a[0] === "hyprctl")[0][4], 'hl.dsp.focus({ window = "address:0xc3" })');
});

test("a terminal always opens a new window, even when one is open", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "open", app: "terminal" }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.tick(300);
  assert.deepEqual(Array.from(h.execs.at(-1)), ["omarchy-launch-terminal"]);
  h.desk.hyprEvent("openwindow", "d4,1,kitty,t", h.now);
  h.snapshot.windows.push(win("0xd4", "kitty", { pid: 444, stableId: "s-444" }));
  h.runAll();
  assert.equal(h.status(r.id).state, "done");
});

test("a folder is resolved before the box, shown, and passed to the app as the real path", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "open", app: "terminal", folder: "~/Development/prj" }]);
  h.autoAnswer(); // lock
  assert.deepEqual(Array.from(h.inflight), ["realpath", "-e", "--", "/home/u/Development/prj"]);
  h.answer("/home/u/Work/prj\n", 0);
  assert.deepEqual(Array.from(h.inflight), ["test", "-d", "/home/u/Work/prj"]);
  h.answer("", 0);
  assert.equal(h.shown.length, 1);
  assert.equal(h.shown[0].content.lines[0].text, '1. Open Terminal in "~/Development/prj" (a link to "~/Work/prj")');
  assert.equal(h.shown[0].content.lines[0].mono, true);
  h.drawBox();
  h.clickAllow();
  h.tick(200);
  assert.deepEqual(Array.from(h.execs.at(-1)), ["uwsm-app", "--", "xdg-terminal-exec", "--dir=/home/u/Work/prj"]);
  assert.ok(r.ok);
});

test("a folder outside home, a hidden target, or a missing folder refuses the request before any box", () => {
  const cases = [
    ["/etc\n", 0, "Step 1: that folder is not in the home folder."],
    ["/home/u/.ssh\n", 0, "Step 1: that folder is not in the home folder."],
    ["/home/user2/x\n", 0, "Step 1: that folder is not in the home folder."],
    ["/home/u/a\nb\n", 0, null],
    ["", 1, "Step 1: that folder does not exist."]
  ];
  for (const [out, code, message] of cases) {
    const h = makeHarness();
    const r = h.propose([{ do: "open", app: "terminal", folder: "x" }]);
    h.autoAnswer();
    h.answer(out, code);
    h.untilBox();
    const s = h.status(r.id);
    assert.equal(s.state, "refused", JSON.stringify(out));
    if (message) assert.equal(s.message, message);
    assert.equal(h.shown.length, 0);
  }
  // The folder exists on the way, but is a file: test -d fails.
  const h = makeHarness();
  const r = h.propose([{ do: "open", app: "terminal", folder: "x" }]);
  h.autoAnswer();
  h.answer("/home/u/x\n", 0);
  h.answer("", 1);
  assert.equal(h.status(r.id).message, "Step 1: that folder does not exist.");
});

test("an app that cannot open in a folder is refused with its name", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "open", app: "obsidian", folder: "x" }]);
  assert.equal(r.ok, false);
  assert.equal(r.message, "Step 1: Obsidian cannot open in a folder.");
});

test("a locked screen, an unknown lock state, or no usable screen refuse before any box", () => {
  const locked = makeHarness();
  const r1 = locked.propose([{ do: "workspace", to: 2 }]);
  locked.answer("true\n", 0);
  assert.equal(locked.status(r1.id).message, locked.V.MSG.locked);
  assert.equal(locked.shown.length, 0);

  for (const [out, code] of [["maybe\n", 0], ["", 0], ["false\n", 1], ["omarchy-shell is not running", 1]]) {
    const h = makeHarness();
    const r = h.propose([{ do: "workspace", to: 2 }]);
    h.answer(out, code);
    assert.equal(h.status(r.id).message, h.V.MSG.lockUnknown, JSON.stringify(out));
    assert.equal(h.shown.length, 0);
  }

  for (const monitor of [null, { name: "HEADLESS-2", dpms: true }, { name: "eDP-1", dpms: false }, { name: "DP-9", dpms: true }]) {
    const h = makeHarness();
    h.snapshot.monitor = monitor;
    const r = h.propose([{ do: "workspace", to: 2 }]);
    h.autoAnswer();
    assert.equal(h.status(r.id).message, h.V.MSG.noScreen, JSON.stringify(monitor));
    assert.equal(h.shown.length, 0);
  }
});

test("a hung process is stopped after its time, hard after one more second, and the request is refused", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.tick(1900);
  assert.deepEqual(h.kills, []);
  h.tick(200);
  assert.deepEqual(h.kills, [false]);
  assert.equal(h.status(r.id).message, h.V.MSG.lockUnknown);
  h.tick(1000);
  assert.deepEqual(h.kills, [false, true]);
  h.answer("", 137); // it finally ends
  assert.equal(h.inflight, null);
  // The next request can use the process slot again.
  h.tick(3000);
  assert.equal(h.propose([{ do: "workspace", to: 3 }]).ok, true);
  assert.deepEqual(Array.from(h.inflight), ["omarchy-shell", "lock", "isLocked"]);
});

test("a job queued behind a process that will not end gives up after 5 s, and a late exit is not taken for its answer", () => {
  const h = makeHarness();
  const r1 = h.propose([{ do: "workspace", to: 2 }]);
  h.tick(2100);
  h.tick(1000);
  assert.deepEqual(h.kills, [false, true]);
  assert.equal(h.status(r1.id).state, "refused");
  h.tick(2000);
  const r2 = h.propose([{ do: "workspace", to: 3 }]);
  assert.equal(r2.ok, true);
  assert.equal(h.started.length, 1, "the second lock check is waiting for the slot");
  h.tick(5100);
  const s2 = h.status(r2.id);
  assert.equal(s2.state, "refused");
  assert.equal(s2.message, h.V.MSG.lockUnknown);
  // The first process finally ends. Nothing else was waiting, so nothing starts.
  h.answer("", 137);
  assert.equal(h.inflight, null);
  h.tick(3000);
  assert.equal(h.propose([{ do: "workspace", to: 4 }]).ok, true);
  assert.deepEqual(Array.from(h.inflight), ["omarchy-shell", "lock", "isLocked"]);
});

test("a failed dispatch stops the run and returns Hyprland's answer, cleaned", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }, { do: "workspace", to: 3 }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.tick(200);
  h.answer("error: no such dispatcher " + String.fromCharCode(27) + "[31m\n", 7);
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  // The control character became a space; nothing that is not printable ASCII survives.
  assert.match(s.message, /^Step 1 failed: Hyprland said: error: no such dispatcher \[31m\. The steps after it did not run\.$/);
  assert.match(s.message, /^[\x20-\x7E]+$/);
  assert.equal(h.started.filter((a) => a[0] === "hyprctl").length, 1);
  assert.equal(Array.from(s.steps).length, 1);
  assert.equal(s.steps[0].ok, false);
});

// A fake desktop for the layout steps. `truth` is the layout Hyprland really has; `cache` is Quickshell's copy of it, which
// only catches up when the model refreshes (review C5). The toggle script flips dwindle and scrolling like the real one
// (anything else becomes dwindle), and changes the truth only: no event refreshes the cache.
function layoutDesk(truth, cache) {
  const h = makeHarness();
  h.truth = truth;
  h.snapshot.activeLayout = cache;
  h.onRefresh = () => { h.snapshot.activeLayout = h.truth; };
  h.onExec = (argv) => {
    if (argv[0].includes("layout-toggle")) h.truth = h.truth === "dwindle" ? "scrolling" : "dwindle";
  };
  return h;
}

function runLayout(h, mode) {
  const r = h.propose([{ do: "layout", mode }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.runAll();
  return h.status(r.id);
}

const toggles = (h) => h.execs.filter((a) => a[0].includes("layout-toggle")).length;

test("a layout step only toggles when the layout differs", () => {
  const same = layoutDesk("dwindle", "dwindle");
  const s = runLayout(same, "tiled");
  assert.equal(s.state, "done");
  assert.equal(notes(s)[0], "Switch this workspace to the tiled layout: done (it already was)");
  assert.equal(toggles(same), 0);

  const diff = layoutDesk("scrolling", "scrolling");
  const s2 = runLayout(diff, "tiled");
  assert.equal(s2.state, "done");
  assert.deepEqual(Array.from(diff.execs.find((a) => a[0].includes("layout-toggle"))), ["omarchy-hyprland-workspace-layout-toggle"]);
  assert.equal(notes(s2)[0], "Switch this workspace to the tiled layout: done");

  const odd = layoutDesk("master", "master");
  assert.equal(runLayout(odd, "scrolling").state, "failed");
  assert.equal(toggles(odd), 0, "an unknown layout is not toggled blind");
});

test("the layout is read after a refresh: a stale or empty cached layout does not cause a wrong toggle (review C5)", () => {
  // [workspace 7 (new), layout tiled]: the cache is still empty, the workspace really is tiled.
  const fresh = layoutDesk("dwindle", "");
  const before = fresh.refreshes;
  const s = runLayout(fresh, "tiled");
  assert.ok(fresh.refreshes > before, "the model asked Hyprland before it read");
  assert.equal(s.state, "done");
  assert.equal(notes(s)[0], "Switch this workspace to the tiled layout: done (it already was)");
  assert.equal(toggles(fresh), 0, "no toggle: an empty cache would have read as 'other' and toggled to scrolling");
  assert.equal(fresh.truth, "dwindle");

  // The cache says tiled, but the layout was changed by key since (no event refreshes the cache): asking for scrolling must not
  // be taken for "already".
  const stale = layoutDesk("scrolling", "dwindle");
  const s2 = runLayout(stale, "scrolling");
  assert.equal(s2.state, "done");
  assert.equal(notes(s2)[0], "Switch this workspace to the scrolling layout: done (it already was)");
  assert.equal(toggles(stale), 0);

  // And the stale cache says scrolling while the layout is tiled: asking for scrolling toggles once, and ends scrolling.
  const stale2 = layoutDesk("dwindle", "scrolling");
  const s3 = runLayout(stale2, "scrolling");
  assert.equal(s3.state, "done");
  assert.equal(toggles(stale2), 1);
  assert.equal(stale2.truth, "scrolling");
});

test("the layout is read again after the toggle, and the step fails if it is not the one asked for (review C5)", () => {
  const h = layoutDesk("dwindle", "dwindle");
  h.onExec = () => { /* the toggle did nothing */ };
  const s = runLayout(h, "scrolling");
  assert.equal(toggles(h), 1);
  assert.equal(s.state, "failed");
  assert.equal(s.message, "Step 1 failed: the layout is not the one asked for. The steps after it did not run.");

  // After the toggle the refresh is asked for again, and the new layout is what is read.
  const ok = layoutDesk("dwindle", "dwindle");
  const r = ok.propose([{ do: "layout", mode: "scrolling" }]);
  ok.untilBox();
  ok.drawBox();
  ok.clickAllow();
  const atClick = ok.refreshes;
  ok.runAll();
  assert.equal(ok.status(r.id).state, "done");
  assert.ok(ok.refreshes - atClick >= 2, "one refresh before the read and one after the toggle");
  assert.equal(ok.snapshot.activeLayout, "scrolling");
});

test("a layout that cannot be read at all is not toggled blind (review C5)", () => {
  const h = layoutDesk("dwindle", "");
  h.onRefresh = () => { /* the answer never arrives */ };
  const s = runLayout(h, "tiled");
  assert.equal(s.state, "failed");
  assert.equal(s.message, "Step 1 failed: the layout of this workspace could not be read. The steps after it did not run.");
  assert.equal(toggles(h), 0);
});

test("commands that are started get a pause, so two toggles in a row do not race", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "desktop", what: "nightlight" }, { do: "desktop", what: "nightlight" }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.tick(200);
  assert.equal(h.execs.filter((a) => a[0] === "omarchy-toggle-nightlight").length, 1);
  h.tick(500);
  assert.equal(h.execs.filter((a) => a[0] === "omarchy-toggle-nightlight").length, 1, "still in the pause");
  h.tick(300);
  assert.equal(h.execs.filter((a) => a[0] === "omarchy-toggle-nightlight").length, 2);
  h.runAll();
  assert.equal(h.status(r.id).state, "done");
});

test("the desk state holds catalogue words and numbers only, and fits in 8 KiB with 128 windows", () => {
  const h = makeHarness();
  h.snapshot.windows = [
    win("0xa1", VSCODE, { workspaceId: 2, workspaceName: "2", focused: true, focusHistoryID: 0 }),
    win("0xb2", "some.private.App", { workspaceId: 2, workspaceName: "2", focusHistoryID: 1, floating: true }),
    win("0xc3", "spotify", { workspaceId: -98, workspaceName: "special:scratchpad", focusHistoryID: 2 })
  ];
  h.snapshot.activeWorkspace = 2;
  h.snapshot.workspaces = [{ id: 2, layout: "scrolling" }, { id: 3, layout: "dwindle" }];
  const out = JSON.parse(h.desk.state(h.now));
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    v: 1, active_workspace: 2,
    workspaces: [{ id: 2, layout: "scrolling", windows: [
      { app: "vscode", focused: true, floating: false, fullscreen: false },
      { app: "other", focused: false, floating: true, fullscreen: false }
    ] }],
    scratchpad: 1
  });
  assert.ok(!JSON.stringify(out).includes("private"));

  const big = makeHarness();
  big.snapshot.windows = [];
  for (let i = 0; i < 200; i++) big.snapshot.windows.push(win("0x" + (i + 1).toString(16), VSCODE, { workspaceId: 1 + (i % 10), workspaceName: String(1 + (i % 10)), focusHistoryID: i, focused: i === 0 }));
  big.snapshot.activeWorkspace = 1;
  const text = big.desk.state(big.now);
  assert.ok(text.length <= 8192, "length " + text.length);
  const parsed = JSON.parse(text);
  const total = parsed.workspaces.reduce((n, w) => n + w.windows.length, 0);
  assert.ok(total <= 128 && total > 80);
});

test("the log: ASCII lines in a state folder made first, one line per event, no folder names", () => {
  const h = makeHarness();
  h.desk.start(h.now);
  assert.deepEqual(Array.from(h.inflight), ["mkdir", "-p", "-m", "700", "--", "/home/u/.local/state/omacommand"]);
  h.answer("", 0);
  assert.deepEqual(Array.from(h.inflight), ["mv", "-f", "--", "/home/u/.local/state/omacommand/events.log", "/home/u/.local/state/omacommand/events.1.log"]);
  assert.equal(h.logWrites.length, 0, "nothing is written before the folder exists");
  h.answer("", 1); // there was no earlier log
  assert.equal(h.logPath, "/home/u/.local/state/omacommand/events.log");
  assert.deepEqual(Array.from(h.inflight), ["test", "-e", "/home/u/.local/state/omacommand/welcome-1"]);
  h.answer("", 0); // the note was shown before
  const r = h.proposeText(h.request({ steps: [{ do: "open", app: "terminal", folder: "~/secret-project" }, { do: "window", what: "close" }] }, { client: "claude-code" }));
  assert.equal(r.ok, true);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.runAll();
  h.tick(300);
  const text = h.logWrites.at(-1);
  assert.ok(text.endsWith("\n"));
  const lines = text.trim().split("\n");
  for (const line of lines) {
    assert.match(line, /^[\x20-\x7E]{1,200}$/);
    assert.match(line, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (--------|[0-9a-f]{8}) \S/);
  }
  assert.ok(lines.some((l) => l.includes(" proposed steps=open:terminal(folder),window:close client=\"claude-code\" (self-reported)")), text);
  assert.ok(lines.some((l) => l.includes(" shown")));
  assert.ok(lines.some((l) => / allowed after \d+(\.\d)?s$/.test(l)));
  assert.ok(!text.includes("secret-project"), "no folder names in the log");
  assert.ok(!text.includes("0xa1"), "no addresses in the log");
});

test("the log keeps at most 200 lines and nothing is logged if the folder cannot be made", () => {
  const h = makeHarness();
  h.desk.start(h.now);
  h.answer("", 0);
  h.answer("", 0);
  h.answer("", 0); // test -e: exists
  for (let i = 0; i < 300; i++) {
    h.tick(2100);
    h.desk.state(h.now);
    h.tick(1000);
  }
  const lines = h.logWrites.at(-1).trim().split("\n");
  assert.equal(lines.length, 200);

  const bad = makeHarness();
  bad.desk.start(bad.now);
  bad.answer("", 1); // mkdir failed
  bad.answer("", 0); // welcome check
  bad.desk.state(bad.now);
  bad.tick(500);
  assert.equal(bad.logWrites.length, 0);
  assert.equal(bad.logPath, null);
});

test("the welcome note shows once when its marker is missing, and writes nothing else", () => {
  const h = makeHarness();
  h.desk.start(h.now);
  h.answer("", 0); // mkdir
  h.answer("", 0); // mv
  h.answer("", 1); // test -e: no marker
  assert.equal(h.welcomes.length, 1);
  assert.equal(h.welcomes[0].marker, "/home/u/.local/state/omacommand/welcome-1");
  // While the note is open, proposals are refused with a fixed sentence.
  const r = h.propose([{ do: "workspace", to: 2 }]);
  assert.equal(r.ok, false);
  assert.equal(r.message, h.V.MSG.welcomeOpen);
  h.desk.welcomeClosed(h.now);
  h.tick(3000);
  assert.equal(h.propose([{ do: "workspace", to: 2 }]).ok, true);

  const seen = makeHarness();
  seen.desk.start(seen.now);
  seen.answer("", 0);
  seen.answer("", 0);
  seen.answer("", 0); // marker exists
  assert.equal(seen.welcomes.length, 0);

  const nomarker = makeHarness();
  nomarker.desk.start(nomarker.now);
  nomarker.answer("", 1); // mkdir failed: the note still shows once, but cannot write its marker
  nomarker.answer("", 1);
  assert.equal(nomarker.welcomes.length, 1);
  assert.equal(nomarker.welcomes[0].marker, "");
});

test("a welcome note that is due while a request is open waits for it to end", () => {
  const h = makeHarness();
  h.desk.start(h.now);
  h.answer("", 0); // mkdir
  h.answer("", 0); // mv; the marker check is running now
  // A proposal arrives while that check is running.
  const r = h.propose([{ do: "workspace", to: 2 }]);
  assert.equal(r.ok, true);
  h.answer("", 1); // the marker is missing, so the note is due, but a request is open
  assert.equal(h.welcomes.length, 0);
  h.untilBox();
  assert.equal(h.welcomes.length, 0, "never at the same time as an Allow box");
  h.drawBox();
  h.desk.box.deny(h.now);
  assert.equal(h.welcomes.length, 1);
});

test("a restart forgets everything: a fresh desk knows no request", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }]);
  assert.equal(h.status(r.id).state, "pending");
  const fresh = makeHarness();
  assert.equal(JSON.parse(fresh.desk.status(r.id, fresh.now)).state, "unknown");
});

test("ping answers with the version and ready", () => {
  const h = makeHarness();
  assert.deepEqual(JSON.parse(h.desk.ping()), { v: 1, name: "omacommand", version: "1.0.0", ready: true });
});

test("window events cause one debounced refresh, not one per event", () => {
  const h = makeHarness();
  h.desk.hyprEvent("openwindow", "a9,1,kitty,t", h.now);
  h.desk.hyprEvent("closewindow", "a8", h.now);
  h.desk.hyprEvent("movewindowv2", "a7,2,x", h.now);
  h.desk.hyprEvent("windowtitlev2", "a6,t", h.now);
  assert.equal(h.refreshes, 0);
  h.tick(100);
  assert.equal(h.refreshes, 0);
  h.tick(200);
  assert.equal(h.refreshes, 1);
  h.tick(1000);
  assert.equal(h.refreshes, 1);
});

test("the shell name in a Hyprland event can never break the desk", () => {
  const h = makeHarness();
  for (const [name, data] of [["openwindow", ""], ["openwindow", ",,,"], ["closewindow", "zzzz"], ["closewindow", "0x" + "f".repeat(40)], ["", ""], ["x", "y"]]) {
    h.desk.hyprEvent(name, data, h.now);
  }
  assert.ok(true);
});

// ---------------------------------------------------------------- C6: an internal error ends the request
test("noteInternal finishes the open request as failed, closes its box and stops the ticks (review C6)", () => {
  const h = makeHarness();
  h.desk.start(h.now);
  h.answer("", 0); // mkdir
  h.answer("", 0); // mv
  h.answer("", 0); // the welcome marker is there
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.untilBox();
  h.drawBox();
  const hiddenBefore = h.hidden;
  h.desk.noteInternal("tick", h.now);
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.equal(s.message, h.V.MSG.internal);
  assert.ok(h.hidden > hiddenBefore, "the box was taken down");
  h.tick(300);
  assert.equal(h.desk.needsTick(), false, "no tick goes on repeating");
  assert.ok(h.logWrites.at(-1).split("\n").some((l) => l.endsWith(" internal-error:tick")), h.logWrites.at(-1));
  // The box is gone: a late Deny or Esc changes nothing, and the next request can start.
  h.desk.box.deny(h.now);
  assert.equal(h.status(r.id).state, "failed");
  h.tick(3000);
  assert.equal(h.propose([{ do: "workspace", to: 3 }]).ok, true);
});

test("an internal error after Allow says that some steps may have run (review C6)", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }, { do: "workspace", to: 3 }]);
  h.untilBox();
  h.drawBox();
  h.clickAllow();
  h.tick(200);
  assert.equal(h.inflight[0], "hyprctl");
  h.desk.noteInternal("event", h.now);
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.equal(s.message, h.V.MSG.internalRunning);
  assert.ok(!s.message.includes("Nothing ran"));
  // The late answer of the dispatch that was in flight does not start the next step.
  h.answer("ok\n", 0);
  h.runAll();
  assert.equal(h.started.filter((a) => a[0] === "hyprctl").length, 1);
  assert.equal(h.status(r.id).state, "failed");
});

test("noteInternal with no request open only logs, and never throws (review C6)", () => {
  const h = makeHarness();
  h.desk.noteInternal("kill", h.now);
  h.desk.noteInternal(undefined, h.now);
  h.desk.noteInternal("A weird\nword!", h.now);
  assert.equal(h.desk.needsTick(), false);
});

// ---------------------------------------------------------------- C7: the process slot is always freed
test("a process that never started frees the slot at once, and the next job runs (review C7)", () => {
  const h = makeHarness();
  h.desk.start(h.now);
  assert.deepEqual(Array.from(h.inflight), ["mkdir", "-p", "-m", "700", "--", "/home/u/.local/state/omacommand"]);
  h.answer("", -1); // the service reports code -1 and no output when the start failed
  assert.deepEqual(Array.from(h.inflight), ["test", "-e", "/home/u/.local/state/omacommand/welcome-1"], "the next job started");
});

test("a kill that finds nothing running frees the slot from inside the call: the job is answered as timed out, once (review C7)", () => {
  const h = makeHarness();
  h.finishOnKill = true;
  const r = h.propose([{ do: "workspace", to: 2 }]);
  assert.deepEqual(Array.from(h.inflight), ["omarchy-shell", "lock", "isLocked"]);
  h.tick(2100);
  assert.deepEqual(h.kills, [false]);
  assert.equal(h.inflight, null, "the slot is free");
  assert.equal(h.status(r.id).message, h.V.MSG.lockUnknown);
  h.tick(2000);
  h.tick(2000);
  assert.deepEqual(h.kills, [false], "no hard kill follows: nothing is running");
  assert.equal(h.propose([{ do: "workspace", to: 3 }]).ok, true);
  assert.deepEqual(Array.from(h.inflight), ["omarchy-shell", "lock", "isLocked"]);

  // The same during a run: the dispatch is answered as timed out, the step fails, the slot is free.
  const run = makeHarness();
  run.finishOnKill = true;
  const r2 = run.propose([{ do: "workspace", to: 2 }]);
  run.untilBox();
  run.drawBox();
  run.clickAllow();
  run.tick(200);
  assert.equal(run.inflight[0], "hyprctl");
  run.tick(3100);
  const s = run.status(r2.id);
  assert.equal(s.state, "failed");
  assert.equal(s.message, "Step 1 failed: Hyprland did not answer in time. The steps after it did not run.");
  assert.equal(run.inflight, null);
});

// ---------------------------------------------------------------- C10: hiding the window reports itself back
test("one Allow writes one 'allowed after' line, validates the plan once and hides the window once (review C10)", () => {
  const h = makeHarness();
  assert.equal(h.hideReports, true, "the fake window reports its own hide, like Quickshell's visible property");
  h.desk.start(h.now);
  h.answer("", 0);
  h.answer("", 0);
  h.answer("", 0);
  let validations = 0;
  const original = h.V.validatePlan;
  h.V.validatePlan = function (p) { validations++; return original.call(h.V, p); };
  const r = h.propose([{ do: "workspace", to: 2 }, { do: "scratchpad" }]);
  h.untilBox();
  h.drawBox();
  const before = validations;
  h.clickAllow();
  assert.equal(validations - before, 1, "validated once more for the run");
  assert.equal(h.hidden, 1, "hidden once");
  h.runAll();
  assert.equal(h.status(r.id).state, "done");
  assert.equal(h.started.filter((a) => a[0] === "hyprctl").length, 2, "each step ran once");
  const lines = h.logWrites.at(-1).trim().split("\n");
  assert.equal(lines.filter((l) => / allowed after /.test(l)).length, 1, h.logWrites.at(-1));
  assert.equal(h.execs.filter((a) => a[0] === "notify-send").length, 1);

  // A no hides the window once too, and finishes once.
  const d = makeHarness();
  const r2 = d.propose([{ do: "workspace", to: 2 }]);
  d.untilBox();
  d.drawBox();
  d.desk.box.deny(d.now);
  assert.equal(d.hidden, 1);
  assert.equal(d.status(r2.id).state, "denied");
});
