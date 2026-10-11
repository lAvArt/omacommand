// Spec 11, test 9: close binds one window when the box is built, and address reuse cannot redirect it.
// Fake toplevels and events are fed to a desk; the checks are the ones of spec 5.5.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness, win } from "./helpers.mjs";

const VSCODE = "com.microsoft.VSCode";
const closePlan = [{ do: "window", what: "close", app: "vscode" }];

function setup(extraWindows) {
  const h = makeHarness();
  h.snapshot.windows = [
    win("0xa1", VSCODE, { pid: 111, stableId: "s-111", workspaceId: 2, workspaceName: "2", focusHistoryID: 1 }),
    win("0xb2", "kitty", { pid: 222, stableId: "s-222", workspaceId: 1, workspaceName: "1", focused: true, focusHistoryID: 0 })
  ].concat(extraWindows || []);
  h.snapshot.activeAddress = "0xb2";
  return h;
}

// Proposes the close, goes through the preparation, and returns the request with the box shown.
function boxFor(h, steps = closePlan) {
  const r = h.propose(steps);
  assert.equal(r.ok, true, JSON.stringify(r));
  h.untilBox();
  return r;
}

function allow(h) {
  h.drawBox();
  h.clickAllow();
}

// The close step has started its refresh wait.
function atVerify(h) {
  h.tick(200);
  assert.equal(h.inflight, null, "no command may be sent before the check");
}

test("the box names the app and the workspace of the one window it will close", () => {
  const h = setup();
  boxFor(h);
  assert.equal(h.shown.length, 1);
  const lines = Array.from(h.shown[0].content.lines, (l) => l.text);
  assert.deepEqual(lines, ["1. Close the VS Code window on workspace 2 (unsaved work in it may be lost)"]);
  assert.equal(h.shown[0].content.lines[0].urgent, true);
  assert.equal(h.shown[0].content.note, "This request closes a window.");
  assert.ok(h.refreshes >= 1, "fresh window data was asked for");
});

test("A closes while the box is open: the request is denied, nothing runs", () => {
  const h = setup();
  const r = boxFor(h);
  h.drawBox();
  h.desk.hyprEvent("closewindow", "a1", h.now);
  const s = h.status(r.id);
  assert.equal(s.state, "denied");
  assert.equal(s.message, h.V.MSG.windowClosed);
  assert.ok(h.hidden >= 1, "the box was taken down");
  h.tick(5000);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"), "no dispatch");
});

test("A closes after Allow: the step fails and no close is sent", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  assert.equal(h.status(r.id).state, "running");
  h.desk.hyprEvent("closewindow", "a1", h.now);
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.match(s.message, /^Step 1 failed: That window is already closed\. The steps after it did not run\.$/);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});

test("a new window with A's address and another pid: the step fails", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  atVerify(h);
  h.snapshot.windows[0] = win("0xa1", VSCODE, { pid: 999, stableId: "s-111", workspaceId: 2, workspaceName: "2" });
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.match(s.message, /no longer the same window/);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});

test("a new window with A's address, the same pid and class, after a closewindow for A: the step fails", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  atVerify(h);
  // The same app reopened a window and was handed the address of the old one.
  h.desk.hyprEvent("closewindow", "a1", h.now);
  h.desk.hyprEvent("openwindow", "a1,2," + VSCODE + ",x", h.now);
  h.snapshot.windows[0] = win("0xa1", VSCODE, { pid: 111, stableId: "s-111", workspaceId: 2, workspaceName: "2" });
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.match(s.message, /already closed/);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});

test("a window with A's address, pid and class but another stableId: the step fails", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  atVerify(h);
  h.snapshot.windows[0] = win("0xa1", VSCODE, { pid: 111, stableId: "s-NEW", workspaceId: 2, workspaceName: "2" });
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.match(s.message, /no longer the same window/);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});

test("a window with A's address but another class or initial class: the step fails", () => {
  for (const patch of [{ cls: "kitty" }, { initialClass: "other" }]) {
    const h = setup();
    const r = boxFor(h);
    allow(h);
    atVerify(h);
    h.snapshot.windows[0] = win("0xa1", VSCODE, Object.assign({ pid: 111, stableId: "s-111", workspaceId: 2, workspaceName: "2" }, patch));
    h.runAll();
    assert.equal(h.status(r.id).state, "failed", JSON.stringify(patch));
  }
});

test("A is gone from the window list at the last check: the step fails", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  atVerify(h);
  h.snapshot.windows.splice(0, 1);
  h.runAll();
  assert.equal(h.status(r.id).state, "failed");
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});

test("when nothing changed, exactly one close is sent, for the bound address", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  h.runAll();
  assert.equal(h.status(r.id).state, "done");
  const sent = h.started.filter((a) => a[0] === "hyprctl");
  assert.equal(sent.length, 1);
  assert.deepEqual(Array.from(sent[0]), ["hyprctl", "-i", "0", "dispatch", 'hl.dsp.window.close({ window = "address:0xa1" })']);
  assert.ok(h.execs.some((a) => a[0] === "notify-send" && a[3] === "An AI agent's request ran (1 step)."));
});

test("close without an app binds the window that is active when the proposal arrives", () => {
  const h = setup();
  const r = boxFor(h, [{ do: "window", what: "close" }]);
  const text = h.shown[0].content.lines[0].text;
  assert.equal(text, "1. Close the Terminal window on workspace 1 (unsaved work in it may be lost)");
  allow(h);
  // Focus moves to VS Code before the step runs: the bound window is still the one closed.
  h.snapshot.activeAddress = "0xa1";
  h.runAll();
  assert.equal(h.status(r.id).state, "done");
  const sent = h.started.filter((a) => a[0] === "hyprctl");
  assert.equal(sent[0][4], 'hl.dsp.window.close({ window = "address:0xb2" })');
});

test("a window of an app that is not on the list is named as such", () => {
  const h = setup();
  h.snapshot.windows[1] = win("0xb2", "some.other.App", { pid: 222, stableId: "s-222", focused: true, focusHistoryID: 0 });
  boxFor(h, [{ do: "window", what: "close" }]);
  assert.equal(
    h.shown[0].content.lines[0].text,
    "1. Close a window of an app that is not on Omacommand's list, on workspace 1 (unsaved work in it may be lost)"
  );
});

test("close refuses when no window, or more than one, matches the app", () => {
  const none = setup();
  none.snapshot.windows.splice(0, 1);
  const r1 = boxFor(none);
  none.untilBox();
  assert.equal(none.shown.length, 0);
  const s1 = none.status(r1.id);
  assert.equal(s1.state, "refused");
  assert.equal(s1.message, "Step 1: VS Code is not open.");

  const many = setup([win("0xc3", VSCODE, { pid: 333, stableId: "s-333" }), win("0xd4", VSCODE, { pid: 444, stableId: "s-444" })]);
  const r2 = boxFor(many);
  many.untilBox();
  assert.equal(many.shown.length, 0);
  const s2 = many.status(r2.id);
  assert.equal(s2.state, "refused");
  assert.match(s2.message, /^Step 1: There are 3 VS Code windows\. Omacommand closes a window only when it knows which: ask the person to focus it, then propose closing the current window\.$/);

  const noActive = setup();
  noActive.snapshot.activeAddress = "";
  const r3 = boxFor(noActive, [{ do: "window", what: "close" }]);
  noActive.untilBox();
  assert.equal(noActive.shown.length, 0);
  assert.equal(noActive.status(r3.id).state, "refused");
});

test("a window that closed while the request was prepared refuses it", () => {
  const h = setup();
  const r = h.propose(closePlan);
  // Lock check answered; the close binding waits for the refresh.
  h.autoAnswer();
  h.desk.hyprEvent("closewindow", "a1", h.now);
  h.untilBox();
  assert.equal(h.shown.length, 0);
  assert.equal(h.status(r.id).state, "refused");
  assert.equal(h.status(r.id).message, h.V.MSG.windowChangedWhilePreparing);
});

test("several close steps are each bound and named separately", () => {
  const h = setup([win("0xc3", "org.gnome.Nautilus", { pid: 333, stableId: "s-333", workspaceId: 3, workspaceName: "3" })]);
  boxFor(h, [{ do: "window", what: "close", app: "vscode" }, { do: "window", what: "close", app: "files" }]);
  const lines = Array.from(h.shown[0].content.lines, (l) => l.text);
  assert.deepEqual(lines, [
    "1. Close the VS Code window on workspace 2 (unsaved work in it may be lost)",
    "2. Close the Files window on workspace 3 (unsaved work in it may be lost)"
  ]);
});

test("verifyBinding, on its own: the five conditions of spec 5.5", () => {
  const { V } = makeHarness();
  const a = win("0xa1", VSCODE, { pid: 111, stableId: "s-111" });
  const b = V.bindingOf(a);
  assert.equal(V.verifyBinding(b, [a], {}).ok, true);
  assert.equal(V.verifyBinding(b, [], {}).ok, false, "not in the toplevels");
  assert.equal(V.verifyBinding(b, [a], { "0xa1": true }).ok, false, "invalidated by an event");
  assert.equal(V.verifyBinding(b, [Object.assign({}, a, { pid: 5 })], {}).ok, false, "pid");
  assert.equal(V.verifyBinding(b, [Object.assign({}, a, { cls: "x" })], {}).ok, false, "class");
  assert.equal(V.verifyBinding(b, [Object.assign({}, a, { initialClass: "x" })], {}).ok, false, "initial class");
  assert.equal(V.verifyBinding(b, [Object.assign({}, a, { stableId: "other" })], {}).ok, false, "stableId");
  assert.equal(V.verifyBinding(b, [Object.assign({}, a, { stableId: "" })], {}).ok, false, "a missing stableId fails closed");
  assert.equal(V.verifyBinding(b, [Object.assign({}, a, { mapped: false })], {}).ok, false, "not mapped");
});

test("addresses are accepted with or without 0x and stored with it", () => {
  const { V } = makeHarness();
  assert.equal(V.normAddr("55876ca0eff0"), "0x55876ca0eff0");
  assert.equal(V.normAddr("0x55876CA0EFF0"), "0x55876ca0eff0");
  for (const bad of ["", "0x", "xyz", "0x" + "1".repeat(17), "0x1f ", "address:0x1f", null, 5, "0x1f\n"]) assert.equal(V.normAddr(bad), "", String(bad));
});

test("other steps pick their window when they run: the one the plan opened, else the most recently used of that app", () => {
  const { V } = makeHarness();
  const w1 = win("0x01", VSCODE, { focusHistoryID: 4 });
  const w2 = win("0x02", VSCODE, { focusHistoryID: 2 });
  const k = win("0x03", "kitty", { focusHistoryID: 0 });
  const all = [w1, w2, k];
  assert.equal(V.resolveWindow("vscode", all, {}, "0x03"), "0x02", "most recently used");
  assert.equal(V.resolveWindow("vscode", all, { vscode: "0x01" }, "0x03"), "0x01", "the window this plan opened");
  assert.equal(V.resolveWindow("vscode", all, { vscode: "0x99" }, "0x03"), "0x02", "an opened window that is gone");
  assert.equal(V.resolveWindow("vscode", [k], {}, "0x03"), null, "the app is not open");
  assert.equal(V.resolveWindow(null, all, {}, "0x03"), "0x03", "no app: the active window");
  assert.equal(V.resolveWindow(null, all, {}, ""), null, "no app and no active window");
  assert.equal(V.resolveWindow("vscode", [Object.assign({}, k, { address: "0x02" })], { vscode: "0x02" }, ""), null, "an address now used by another app");
});

test("bound addresses are always recorded as closed, even after a flood of other closewindow events (review C11)", () => {
  const h = setup();
  const r = boxFor(h);
  allow(h);
  atVerify(h);
  // 400 other windows close: the set of closed addresses stops growing for them ...
  for (let i = 0; i < 400; i++) h.desk.hyprEvent("closewindow", (0x100000 + i).toString(16), h.now);
  // ... but not for the bound window. It closes, and the window list still shows a window at that address with the same pid,
  // class and stable id (the refresh has not caught up, or a window of the same app took the address and no open event
  // was seen): only the record of the closewindow event can tell.
  h.desk.hyprEvent("closewindow", "a1", h.now);
  h.snapshot.windows[0] = win("0xa1", VSCODE, { pid: 111, stableId: "s-111", workspaceId: 2, workspaceName: "2" });
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.match(s.message, /already closed/);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"), "no close was sent to the new window");
});

test("a window is bound only with a real pid and a stable id; two empty records never pass for each other (review C11)", () => {
  const { V } = makeHarness();
  assert.equal(V.bindable(win("0xa1", VSCODE, { pid: 111, stableId: "s-111" })), true);
  for (const patch of [{ pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: "7" }, { pid: undefined }, { stableId: "" }, { stableId: undefined }, { stableId: 5 }, { pid: 0, stableId: "" }]) {
    assert.equal(V.bindable(win("0xa1", VSCODE, patch)), false, JSON.stringify(patch));
  }
  assert.equal(V.bindable(null), false);
  assert.equal(V.bindable({}), false);

  const cannot = (h) => "Step 1: " + h.V.MSG.cannotTell;
  for (const patch of [{ pid: 0 }, { stableId: "" }, { pid: 0, stableId: "" }, { pid: -3 }, { stableId: undefined }]) {
    // the window of one app, found by its app
    const byApp = setup();
    byApp.snapshot.windows[0] = win("0xa1", VSCODE, Object.assign({ pid: 111, stableId: "s-111", workspaceId: 2, workspaceName: "2", focusHistoryID: 1 }, patch));
    const r1 = byApp.propose(closePlan);
    byApp.untilBox();
    assert.equal(byApp.shown.length, 0, "no box: " + JSON.stringify(patch));
    assert.equal(byApp.status(r1.id).state, "refused");
    assert.equal(byApp.status(r1.id).message, cannot(byApp));
    // the active window, whatever its app
    const active = setup();
    active.snapshot.windows[1] = win("0xb2", "kitty", Object.assign({ pid: 222, stableId: "s-222", workspaceId: 1, focused: true, focusHistoryID: 0 }, patch));
    const r2 = active.propose([{ do: "window", what: "close" }]);
    active.untilBox();
    assert.equal(active.shown.length, 0);
    assert.equal(active.status(r2.id).message, cannot(active));
  }
  // A window read from a record that is still empty (no pid, no stable id, no class) is refused as well.
  const empty = setup();
  empty.snapshot.windows[1] = { address: "0xb2", stableId: "", pid: 0, cls: "", initialClass: "", workspaceId: 0, workspaceName: "", mapped: true };
  const r3 = empty.propose([{ do: "window", what: "close" }]);
  empty.untilBox();
  assert.equal(empty.shown.length, 0);
  assert.equal(empty.status(r3.id).message, cannot(empty));
});

test("a step that names an app which is not open fails and sends nothing", () => {
  const h = setup();
  const r = h.propose([{ do: "window", what: "float", app: "spotify" }]);
  h.untilBox();
  allow(h);
  h.runAll();
  const s = h.status(r.id);
  assert.equal(s.state, "failed");
  assert.match(s.message, /^Step 1 failed: Spotify is not open\./);
  assert.ok(!h.started.some((a) => a[0] === "hyprctl"));
});
