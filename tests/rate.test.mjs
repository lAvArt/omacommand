// Spec 11, test 5: rate limits and cool-downs (spec 3.5), first on the guard alone, then through a desk.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.mjs";

function guard() {
  const { M, V } = makeHarness();
  return { g: M.createGuard(V), V };
}

test("proposals are spaced at least 2 s after the previous one ended", () => {
  const { g, V } = guard();
  assert.equal(g.check(0), null, "the first proposal");
  g.ended(1000, "done");
  assert.equal(g.check(2999).message, V.MSG.rate);
  assert.equal(g.check(3000), null);
});

test("after a Deny or a timeout there is a 10 s cool-down, after a finished run there is not", () => {
  const { g, V } = guard();
  g.ended(0, "deny");
  assert.equal(g.check(9999).message, V.MSG.rate);
  assert.equal(g.check(10000), null);
  const t = guard();
  t.g.ended(0, "timeout");
  assert.equal(t.g.check(9999).message, t.V.MSG.rate);
  assert.equal(t.g.check(10000), null);
  const d = guard();
  d.g.ended(0, "done");
  assert.equal(d.g.check(2000), null);
});

test("3 Denies or timeouts within 10 minutes pause all proposals for 10 minutes", () => {
  const { g, V } = guard();
  assert.equal(g.ended(0, "deny"), "");
  assert.equal(g.ended(20000, "timeout"), "");
  assert.equal(g.ended(40000, "deny"), "paused-10m");
  const paused = g.check(41000);
  assert.equal(paused.message, V.paused(10));
  assert.match(paused.message, /^Omacommand is paused for 10 more minutes because the person said no several times\.$/);
  assert.equal(g.check(40000 + 599000).message, V.paused(1));
  assert.equal(g.check(40000 + 600000), null);
});

test("3 Denies spread over more than 10 minutes do not pause", () => {
  const { g } = guard();
  g.ended(0, "deny");
  g.ended(400000, "deny");
  assert.equal(g.ended(800000, "deny"), "", "the first one is 13 minutes old");
  assert.equal(g.check(811000), null);
});

test("Deny and pause 1 hour pauses at once", () => {
  const { g, V } = guard();
  assert.equal(g.ended(0, "denypause"), "paused-1h");
  assert.equal(g.check(60000).message, V.paused(59));
  assert.equal(g.check(3599000).message, V.paused(1));
  assert.equal(g.check(3600000), null);
});

test("more than 20 invalid proposals in 60 s pause for 60 s", () => {
  const { g, V } = guard();
  for (let i = 0; i < 20; i++) g.invalid(i * 1000);
  assert.equal(g.check(25000), null, "20 are still fine");
  g.invalid(21000);
  assert.equal(g.check(22000).message, V.MSG.invalidPause);
  assert.equal(g.check(21000 + 59000).message, V.MSG.invalidPause);
  assert.equal(g.check(21000 + 60000), null);
});

test("invalid proposals older than 60 s are forgotten", () => {
  const { g } = guard();
  for (let i = 0; i < 20; i++) g.invalid(i * 100);
  g.invalid(61000);
  assert.equal(g.check(70000), null);
});

test("state() may be asked once a second", () => {
  const { g } = guard();
  assert.equal(g.allowState(0), true);
  assert.equal(g.allowState(500), false);
  assert.equal(g.allowState(999), false);
  assert.equal(g.allowState(1000), true);
});

test("through a desk: the spacing and the cool-down answer with the fixed sentence", () => {
  const h = makeHarness();
  const steps = [{ do: "workspace", to: 2 }];
  const r1 = h.propose(steps);
  assert.equal(r1.ok, true);
  h.untilBox();
  h.drawBox();
  h.desk.box.deny(h.now);
  assert.equal(h.status(r1.id).state, "denied");
  h.tick(5000);
  const early = h.propose(steps);
  assert.equal(early.ok, false);
  assert.equal(early.message, h.V.MSG.rate);
  h.tick(5100);
  assert.equal(h.propose(steps).ok, true, "10 s after the Deny");
});

test("through a desk: 3 Denies pause everything for 10 minutes, then it works again", () => {
  const h = makeHarness();
  const steps = [{ do: "workspace", to: 2 }];
  for (let i = 0; i < 3; i++) {
    h.tick(11000);
    const r = h.propose(steps);
    assert.equal(r.ok, true, "proposal " + i);
    h.shown.length = 0;
    h.untilBox();
    h.drawBox();
    h.desk.box.deny(h.now);
  }
  h.tick(11000);
  const blocked = h.propose(steps);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /^Omacommand is paused for \d+ more minutes? because the person said no several times\.$/);
  h.tick(9 * 60000);
  assert.equal(h.propose(steps).ok, false, "still paused after 9 minutes");
  h.tick(2 * 60000);
  assert.equal(h.propose(steps).ok, true, "after the pause");
});

test("through a desk: 21 invalid proposals in a minute pause for a minute", () => {
  const h = makeHarness();
  let lastMessage = "";
  for (let i = 0; i < 25; i++) {
    h.tick(2100);
    lastMessage = h.propose([]).message;
    if (lastMessage === h.V.MSG.invalidPause) break;
  }
  assert.equal(lastMessage, h.V.MSG.invalidPause);
  h.tick(61000);
  assert.equal(h.propose([]).message, h.V.MSG.noSteps, "the pause is over");
});

test("through a desk: state() is answered once a second and counted in the log", () => {
  const h = makeHarness();
  const first = JSON.parse(h.desk.state(h.now));
  assert.equal(first.v, 1);
  assert.ok("active_workspace" in first);
  h.tick(300);
  const second = JSON.parse(h.desk.state(h.now));
  assert.equal(second.ok, false);
  assert.equal(second.message, h.V.MSG.stateRate);
  h.tick(800);
  assert.equal(JSON.parse(h.desk.state(h.now)).v, 1);
});
