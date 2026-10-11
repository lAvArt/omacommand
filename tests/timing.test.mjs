// Spec 11, test 4: the input rules of the Allow box, driven with a fake clock (box_model.js).
// Every scenario uses its own model and moves the clock forward only, except the one that tests a clock stepping back.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.mjs";

function model() {
  const { M, V } = makeHarness();
  return M.createBoxModel(V);
}

// Visible, sized, the first frame presented at t0 + 20, and the window becomes active 4 ms AFTER that frame: this is the order
// of the pilot on the real machine (frame at 45 ms, focus at 49 ms). A still box draws no other frame, and the first focus must
// not throw the first one away (review C1). drawnAt = t0 + 20, so Allow opens 1000 ms later.
function openBox(m, t0 = 0) {
  m.show(t0, "eDP-1");
  m.visibleChanged(true, t0);
  m.geometry(true, t0);
  m.frame(t0 + 20);
  m.activeChanged(true, t0 + 24);
  return t0 + 20;
}

// A mouse or touch click. Pass null for tMove when the pointer never moved.
function click(m, tMove, tPress, tRelease, kind = "mouse", inside = true) {
  if (tMove !== null) m.pointerMoved(tMove);
  m.press(kind, tPress);
  m.release(inside, tRelease);
}

test("a press 1 ms before drawnAt + 1000 is refused", () => {
  const m = model();
  const d = openBox(m);
  click(m, d + 400, d + 999, d + 1000);
  assert.equal(m.decision(), null);
});

test("a press before the delay ends and a release after it is refused", () => {
  const m = model();
  const d = openBox(m);
  click(m, d + 400, d + 500, d + 1500);
  assert.equal(m.decision(), null);
});

test("a click exactly at drawnAt + 1000, with the pointer moved then, is accepted", () => {
  const m = model();
  const d = openBox(m);
  click(m, d + 1000, d + 1000, d + 1010);
  assert.equal(m.decision(), "allow");
});

test("a press after the delay with no pointer motion at all is refused, with a hint", () => {
  const m = model();
  const d = openBox(m);
  click(m, null, d + 1200, d + 1250);
  assert.equal(m.decision(), null);
  assert.equal(m.view(d + 1260).hint, "Move the pointer over Allow, then click.");
});

test("a pointer that only moved before the delay ended does not count", () => {
  const m = model();
  const d = openBox(m);
  click(m, d + 300, d + 1300, d + 1350);
  assert.equal(m.decision(), null);
  click(m, d + 1400, d + 1410, d + 1450);
  assert.equal(m.decision(), "allow", "a move after the delay, then a click");
});

test("a release outside Allow does not approve", () => {
  const m = model();
  const d = openBox(m);
  click(m, d + 1100, d + 1110, d + 1150, "mouse", false);
  assert.equal(m.decision(), null);
});

test("touch: the touch must begin after the delay, and needs no pointer motion", () => {
  const early = model();
  const d = openBox(early);
  click(early, null, d + 900, d + 1100, "touch");
  assert.equal(early.decision(), null, "a touch that began early");
  const late = model();
  const d2 = openBox(late);
  click(late, null, d2 + 1100, d2 + 1150, "touch");
  assert.equal(late.decision(), "allow");
});

test("keys never approve: Enter, Return, keypad Enter, Space, letters and repeats", () => {
  const m = model();
  const d = openBox(m);
  let t = d + 2000;
  m.pointerMoved(t);
  for (const name of ["enter", "space", "a", "b", "other", "tab"]) {
    m.key(name, false, ++t);
    assert.equal(m.decision(), null, name);
    m.key(name, true, ++t);
    assert.equal(m.decision(), null, name + " repeated");
  }
  assert.equal(m.view(t).hint, "Click Allow with the mouse.");
  // Keys and a pointer that sits still together are still not a click.
  m.press("mouse", ++t);
  m.release(true, ++t);
  assert.equal(m.decision(), "allow", "a real click, after the pointer moved, still works");
  const m2 = model();
  const d2 = openBox(m2);
  m2.key("enter", false, d2 + 2000);
  m2.press("mouse", d2 + 2010);
  m2.release(true, d2 + 2020);
  assert.equal(m2.decision(), null, "Enter then a press with no pointer motion");
});

test("Esc denies, also during the delay, but an auto-repeated Esc is ignored", () => {
  const m = model();
  const d = openBox(m);
  m.key("escape", true, d + 100);
  assert.equal(m.decision(), null, "held down from before the box appeared");
  m.key("escape", false, d + 200);
  assert.equal(m.decision(), "deny");
  const m2 = model();
  m2.show(0, "eDP-1");
  m2.key("escape", false, 5);
  assert.equal(m2.decision(), "deny", "Esc works even before the box is drawn");
});

test("Deny and Deny-and-pause need no delay", () => {
  const m = model();
  m.show(0, "eDP-1");
  m.deny(1);
  assert.equal(m.decision(), "deny");
  const m2 = model();
  m2.show(0, "eDP-1");
  m2.denyPause(1);
  assert.equal(m2.decision(), "denypause");
});

test("the 45 s timeout counts from the first full draw and denies", () => {
  const m = model();
  const d = openBox(m, 1000);
  m.tick(d + 44900);
  assert.equal(m.decision(), null);
  m.tick(d + 45000);
  assert.equal(m.decision(), "timeout");
});

test("focus flapping cannot extend the timeout", () => {
  const m = model();
  const d = openBox(m);
  for (let t = d + 1000; t < d + 44000; t += 3000) {
    m.activeChanged(false, t);
    m.activeChanged(true, t + 5);
    m.frame(t + 10);
    m.tick(t + 20);
  }
  assert.equal(m.decision(), null);
  m.tick(d + 45000);
  assert.equal(m.decision(), "timeout");
});

const restarts = {
  "a screen change": (m, t) => m.screenChanged("HDMI-A-1", t),
  "hiding and showing the window": (m, t) => { m.visibleChanged(false, t); m.visibleChanged(true, t + 1); m.geometry(true, t + 2); },
  "losing keyboard focus": (m, t) => m.activeChanged(false, t),
  "a size change": (m, t) => { m.geometry(false, t); m.geometry(true, t + 1); }
};

for (const [name, restart] of Object.entries(restarts)) {
  test(name + " restarts the full 1000 ms delay", () => {
    const m = model();
    const d = openBox(m);
    m.pointerMoved(d + 1500); // Allow was ready, and the pointer was on it
    restart(m, d + 1600);
    m.pointerMoved(d + 1650);
    click(m, d + 1700, d + 1710, d + 1720);
    assert.equal(m.decision(), null, "right after the restart");
    // Focus comes back (if it was lost), and the next frame starts a new delay.
    m.activeChanged(true, d + 1730);
    m.frame(d + 1740);
    click(m, d + 2000, d + 2100, d + 2150);
    assert.equal(m.decision(), null, "inside the new delay");
    click(m, d + 2800, d + 2810, d + 2820);
    assert.equal(m.decision(), "allow", "after the new delay");
  });
}

test("a press that began before a restart cannot be completed after it", () => {
  const m = model();
  const d = openBox(m);
  m.pointerMoved(d + 1500);
  m.press("mouse", d + 1510);
  m.activeChanged(false, d + 1520);
  m.activeChanged(true, d + 1530);
  m.frame(d + 1540);
  m.release(true, d + 2600);
  assert.equal(m.decision(), null);
});

test("the delay needs a frame: visible and sized is not enough", () => {
  const m = model();
  m.show(0, "eDP-1");
  m.visibleChanged(true, 0);
  m.pointerMoved(1500);
  click(m, 1600, 1610, 1620);
  assert.equal(m.decision(), null, "no frame was ever presented");
  assert.equal(m.view(1700).allowReady, false);
  m.geometry(true, 1700);
  m.frame(1710);
  assert.equal(m.view(2000).allowReady, false);
  assert.equal(m.view(2710).allowReady, true);
});

test("a box that is never drawn is given up on", () => {
  const m = model();
  m.show(0, "eDP-1");
  m.tick(9900);
  assert.equal(m.decision(), null);
  m.tick(10000);
  assert.equal(m.decision(), "timeout");
});

test("a clock that steps back cannot make Allow ready earlier", () => {
  const m = model();
  const d = openBox(m);
  m.tick(d + 500);
  m.tick(d + 100); // the wall clock stepped back by 400 ms; the model's own clock stays at d + 500
  click(m, d + 300, d + 400, d + 450); // 700, 800, 850 ms after the draw in real time
  assert.equal(m.decision(), null);
  click(m, d + 650, d + 660, d + 670); // 1050, 1060, 1070 ms after the draw in real time
  assert.equal(m.decision(), "allow");
});

test("a long stall restarts the delay but does not lengthen the timeout", () => {
  const m = model();
  const d = openBox(m);
  m.tick(d + 500);
  m.tick(d + 6600); // 6 s of nothing: nobody could have seen the box
  click(m, d + 6700, d + 6710, d + 6720);
  assert.equal(m.decision(), null, "right after the stall");
  m.tick(d + 45000);
  assert.equal(m.decision(), "timeout");
});

test("the countdown shows in the last 10 seconds only", () => {
  const m = model();
  const d = openBox(m);
  m.tick(d + 5000);
  m.tick(d + 10000);
  m.tick(d + 15000);
  m.tick(d + 20000);
  m.tick(d + 25000);
  m.tick(d + 30000);
  assert.equal(m.view(d + 30000).countdown, 0);
  assert.equal(m.view(d + 35000).countdown, 10);
  assert.equal(m.view(d + 44500).countdown, 1);
});

test("a second proposal while the box is open is busy, and the first request is untouched", () => {
  const h = makeHarness();
  const first = h.propose([{ do: "workspace", to: 2 }]);
  assert.equal(first.ok, true);
  h.untilBox();
  h.drawBox();
  const second = h.propose([{ do: "workspace", to: 3 }]);
  assert.equal(second.ok, false);
  assert.equal(second.message, h.V.MSG.busy);
  assert.equal(h.shown.length, 1);
  assert.equal(h.status(first.id).state, "pending");
});

test("the box times out through the desk after 45 s without an answer", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.untilBox();
  h.drawBox();
  for (let i = 0; i < 44; i++) h.tick(1000);
  assert.equal(h.status(r.id).state, "pending");
  for (let i = 0; i < 3; i++) h.tick(1000);
  const s = h.status(r.id);
  assert.equal(s.state, "timeout");
  assert.equal(s.message, h.V.MSG.timeout);
  assert.equal(h.hidden >= 1, true);
});

// ---------------------------------------------------------------- C1: the first frame must count, and a restart asks for a frame
test("the first focus gain does not restart the delay: a loss does, and so does a regain after it (review C1, spec 3.3)", () => {
  const m = model();
  const d = openBox(m); // the frame at d, the first focus at d + 4
  assert.equal(m.wantsFrame(), false, "the frame was counted, none is needed");
  assert.equal(m.view(d + 999).allowReady, false);
  assert.equal(m.view(d + 1000).allowReady, true, "ready 1000 ms after the first frame, with no other frame and no input");
  click(m, d + 1000, d + 1000, d + 1010);
  assert.equal(m.decision(), "allow");

  // A loss restarts, and a regain after the loss restarts again ("loses and regains").
  const m2 = model();
  const d2 = openBox(m2);
  m2.activeChanged(false, d2 + 300);
  assert.equal(m2.wantsFrame(), true);
  m2.frame(d2 + 310);
  m2.activeChanged(true, d2 + 320);
  assert.equal(m2.wantsFrame(), true, "the regain threw the frame away and asks for a new one");
  m2.frame(d2 + 330);
  assert.equal(m2.view(d2 + 330 + 999).allowReady, false);
  assert.equal(m2.view(d2 + 330 + 1000).allowReady, true, "one second after the frame that followed the regain");
  // The same event twice is not a change.
  m2.activeChanged(true, d2 + 340);
  assert.equal(m2.view(d2 + 330 + 1000).allowReady, true);
});

test("a box asks for a frame while it is visible and none is counted, and for nothing else (review C1)", () => {
  const m = model();
  assert.equal(m.wantsFrame(), false, "no box yet");
  m.show(0, "eDP-1");
  assert.equal(m.wantsFrame(), false, "not visible yet");
  m.visibleChanged(true, 0);
  m.geometry(true, 0);
  assert.equal(m.wantsFrame(), true, "visible and no frame");
  m.frame(45);
  assert.equal(m.wantsFrame(), false, "counted");
  m.visibleChanged(false, 100);
  assert.equal(m.wantsFrame(), false, "hidden boxes are not asked");
  m.visibleChanged(true, 110);
  assert.equal(m.wantsFrame(), true);
  m.frame(120);
  m.deny(130);
  m.visibleChanged(true, 140);
  m.activeChanged(false, 150);
  assert.equal(m.wantsFrame(), false, "a decided box is not asked");
  m.close();
  assert.equal(m.wantsFrame(), false);
});

test("pilot order through the desk: first frame, focus 4 ms later, no more frames: Allow is ready 1 s after the first frame (review C1)", () => {
  const h = makeHarness();
  h.autoFrames = false; // the window sends a frame only if it is asked, and this box needs none
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.untilBox();
  h.desk.box.visible(true, h.now);
  h.desk.box.size(true, h.now);
  h.tick(45);
  h.desk.box.frame(h.now); // the first frame
  const drawn = h.now;
  h.tick(4);
  h.desk.box.active(true, h.now); // focus, 4 ms later
  const asked = h.frameRequests;
  while (h.now < drawn + 990) h.tick(10);
  assert.equal(h.desk.boxView(h.now).allowReady, false, "990 ms after the frame");
  h.tick(10);
  assert.equal(h.desk.boxView(h.now).allowReady, true, "1000 ms after the first frame, with no input at all");
  assert.equal(h.frameRequests, asked, "no frame was needed, so none was asked for");
  h.desk.box.pointerAt(10, 10, h.now);
  h.tick(10);
  h.desk.box.pointerAt(14, 10, h.now);
  h.tick(10);
  h.desk.box.press("mouse", h.now);
  h.tick(20);
  h.desk.box.release(true, h.now);
  assert.equal(h.status(r.id).state, "running");
});

const DESK_RESTARTS = {
  "a focus loss": (h) => h.desk.box.active(false, h.now),
  "hiding and showing the window": (h) => { h.desk.box.visible(false, h.now); h.tick(10); h.desk.box.visible(true, h.now); h.desk.box.size(true, h.now); },
  "a screen change": (h) => h.desk.box.screen("HDMI-A-1", h.now),
  "a size change": (h) => { h.desk.box.size(false, h.now); h.tick(10); h.desk.box.size(true, h.now); },
  "a stall of the shell": (h) => h.tick(6000)
};

for (const [name, restart] of Object.entries(DESK_RESTARTS)) {
  test(name + " restarts the delay, the window is asked for a frame on every tick until one arrives, then Allow is ready 1 s later (review C1)", () => {
    const h = makeHarness();
    h.autoFrames = false;
    const r = h.propose([{ do: "workspace", to: 2 }]);
    h.untilBox();
    h.drawBox();
    h.tick(1200);
    assert.equal(h.desk.boxView(h.now).allowReady, true, "ready before the restart");
    restart(h);
    assert.equal(h.desk.boxView(h.now).allowReady, false, "not ready right after the restart");
    const before = h.frameRequests;
    for (let i = 0; i < 4; i++) h.tick(50);
    assert.ok(h.frameRequests - before >= 4, "a frame was asked for on every tick: " + (h.frameRequests - before));
    h.desk.box.frame(h.now); // the answer
    const frameAt = h.now;
    const after = h.frameRequests;
    for (let i = 0; i < 4; i++) h.tick(50);
    assert.equal(h.frameRequests, after, "no more asking once a frame is counted");
    while (h.now < frameAt + 990) h.tick(10);
    assert.equal(h.desk.boxView(h.now).allowReady, false);
    h.tick(10);
    assert.equal(h.desk.boxView(h.now).allowReady, true, "1000 ms after the frame that followed the restart");
    assert.equal(h.status(r.id).state, "pending");
  });
}

// ---------------------------------------------------------------- C2: only a changed GLOBAL pointer position is motion
test("pointerAt: the first position only sets the reference, the same position again does not count, a real move does (review C2)", () => {
  const m = model();
  const d = openBox(m);
  m.pointerAt(400, 300, d + 100); // the pointer rested where Allow appeared: the hover when the window mapped
  // After the delay a synthetic hover reports the same global position (a moved button under a still pointer).
  m.pointerAt(400, 300, d + 1200);
  m.pointerAt(400.2, 299.8, d + 1210); // rounding noise from mapping a position back and forth
  m.press("mouse", d + 1300);
  m.release(true, d + 1310);
  assert.equal(m.decision(), null, "no motion since the delay: the click is refused");
  assert.equal(m.view(d + 1320).hint, "Move the pointer over Allow, then click.");
  // A second click, still without moving.
  m.pointerAt(400, 300, d + 1400);
  m.press("mouse", d + 1500);
  m.release(true, d + 1510);
  assert.equal(m.decision(), null, "a second click without moving cannot approve");
  // A real move of one pixel counts.
  m.pointerAt(401, 300, d + 1600);
  m.press("mouse", d + 1610);
  m.release(true, d + 1620);
  assert.equal(m.decision(), "allow");
});

test("pointerAt: positions that are not finite numbers never count, and a slow drift adds up to a move (review C2)", () => {
  for (const bad of [[NaN, 1], [1, NaN], [Infinity, 1], [1, -Infinity], [undefined, 1], [1, undefined], [null, null], ["5", "5"], [{}, []]]) {
    const m = model();
    const d = openBox(m);
    m.pointerAt(bad[0], bad[1], d + 1200);
    m.press("mouse", d + 1300);
    m.release(true, d + 1310);
    assert.equal(m.decision(), null, JSON.stringify(bad));
  }
  const m = model();
  const d = openBox(m);
  m.pointerAt(100, 100, d + 100);
  for (let i = 1; i <= 6; i++) m.pointerAt(100 + i * 0.3, 100, d + 1100 + i * 10); // 0.3 px per event: 1.8 px in all
  m.press("mouse", d + 1300);
  m.release(true, d + 1310);
  assert.equal(m.decision(), "allow", "small steps that add up to a real move count");
});

test("a hover under a pointer that sat still is not motion: a second click without moving cannot approve (review C2, through the desk)", () => {
  const h = makeHarness();
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.untilBox();
  h.drawBox();
  h.desk.box.pointerAt(420, 310, h.now); // the pointer sat where Allow appeared
  h.tick(1100); // Allow is ready; its colour changes, which dirties the scene
  h.desk.box.press("mouse", h.now);
  h.tick(30);
  h.desk.box.release(true, h.now);
  assert.equal(h.status(r.id).state, "pending");
  assert.equal(h.desk.boxView(h.now).hint, h.M.HINT_MOVE);
  // Qt sends a synthetic hover with the pointer where it was.
  h.tick(500);
  h.desk.box.pointerAt(420, 310, h.now);
  h.tick(10);
  h.desk.box.press("mouse", h.now);
  h.tick(30);
  h.desk.box.release(true, h.now);
  assert.equal(h.status(r.id).state, "pending", "the second click, without moving, does not approve");
  // The person moves the pointer, and clicks.
  h.tick(300);
  h.desk.box.pointerAt(424, 311, h.now);
  h.tick(10);
  h.desk.box.press("mouse", h.now);
  h.tick(30);
  h.desk.box.release(true, h.now);
  assert.equal(h.status(r.id).state, "running");
});

test("a first hover that arrives only after Allow is ready is not motion: a pointer that never moved cannot approve", () => {
  const m = model();
  const d = openBox(m);
  // The compositor sends the enter late, for a pointer that sat where Allow appeared.
  m.pointerAt(400, 300, d + 1200);
  m.press("mouse", d + 1300);
  m.release(true, d + 1310);
  assert.equal(m.decision(), null, "the first position only sets the reference");
  assert.equal(m.view(d + 1320).hint, "Move the pointer over Allow, then click.");
  m.pointerAt(403, 300, d + 1400);
  m.press("mouse", d + 1410);
  m.release(true, d + 1420);
  assert.equal(m.decision(), "allow", "a real move after that counts");
});

test("a focus loss and a later regain both restart the delay: Allow is never ready the moment focus comes back (spec 3.3)", () => {
  const h = makeHarness();
  h.autoFrames = false;
  const r = h.propose([{ do: "workspace", to: 2 }]);
  h.untilBox();
  h.drawBox();
  h.tick(1200);
  assert.equal(h.desk.boxView(h.now).allowReady, true, "ready before focus went away");
  h.desk.box.active(false, h.now);
  assert.equal(h.desk.boxView(h.now).allowReady, false, "not ready right after the loss");
  h.tick(50);
  h.desk.box.frame(h.now); // the frame that was asked for after the loss
  for (let i = 0; i < 30; i++) h.tick(50); // 1.5 s without focus
  h.desk.box.active(true, h.now);
  assert.equal(h.desk.boxView(h.now).allowReady, false, "not ready the moment focus comes back");
  const before = h.frameRequests;
  h.tick(50);
  assert.ok(h.frameRequests > before, "a frame is asked for after the regain");
  h.desk.box.frame(h.now);
  const frameAt = h.now;
  while (h.now < frameAt + 990) h.tick(10);
  assert.equal(h.desk.boxView(h.now).allowReady, false);
  h.tick(10);
  assert.equal(h.desk.boxView(h.now).allowReady, true, "1000 ms after the frame that followed the regain");
  assert.equal(h.status(r.id).state, "pending");
});
