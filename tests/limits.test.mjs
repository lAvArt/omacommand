// Spec 11, tests 2 and 3: oversized input, nesting, step and text caps, replayed and expired requests, forgotten ids.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness, installParseCounter, newId } from "./helpers.mjs";

const ws2 = [{ do: "workspace", to: 2 }];

function paddedRequest(h, length, over) {
  const text = h.request({ steps: ws2 }, over);
  assert.ok(text.length < length);
  return text + " ".repeat(length - text.length);
}

test("16,385 characters are refused and JSON.parse is never called", () => {
  const h = makeHarness();
  const parses = installParseCounter(h.ctx);
  const r = h.proposeText(paddedRequest(h, 16385));
  assert.equal(r.ok, false);
  assert.equal(r.message, h.V.MSG.tooLarge);
  assert.equal(parses(), 0);
  assert.equal(h.started.length, 0);
});

test("16,384 characters are still read", () => {
  const h = makeHarness();
  const parses = installParseCounter(h.ctx);
  const r = h.proposeText(paddedRequest(h, 16384));
  assert.equal(r.ok, true);
  assert.equal(parses(), 1);
});

test("nesting 9 is refused before parsing, nesting inside strings does not count", () => {
  const h = makeHarness();
  const parses = installParseCounter(h.ctx);
  const deep = "[".repeat(9) + "1" + "]".repeat(9);
  const r = h.proposeText(deep);
  assert.equal(r.ok, false);
  assert.equal(r.message, h.V.MSG.tooLarge);
  assert.equal(parses(), 0);
  // The same brackets inside a JSON string are not nesting.
  const quiet = makeHarness();
  const parses2 = installParseCounter(quiet.ctx);
  const r2 = quiet.proposeText(quiet.request({ steps: ws2 }, { client: "[[[[[[[[[[[[[[[[" }));
  assert.equal(r2.ok, true);
  assert.equal(parses2(), 1);
});

test("nesting 8 reaches the parser, and a real plan nests only 4 deep", () => {
  const h = makeHarness();
  assert.equal(h.V.nestingTooDeep("[".repeat(8) + "]".repeat(8)), false);
  assert.equal(h.V.nestingTooDeep("[".repeat(9) + "]".repeat(9)), true);
  assert.equal(h.V.nestingTooDeep(h.request({ steps: ws2 })), false);
  assert.equal(h.V.nestingTooDeep('{"a":"\\"[[[[[[[[[[[["}'), false);
});

test("13 steps are refused through propose, with a fixed sentence", () => {
  const h = makeHarness();
  const r = h.propose(new Array(13).fill(ws2[0]));
  assert.equal(r.ok, false);
  assert.equal(r.message, h.V.MSG.tooManySteps);
});

test("a box line over 120 characters refuses the whole request, it is never cut", () => {
  const h = makeHarness();
  const name = "a".repeat(64);
  const folder = "~/" + [name, name, name, name].join("/");
  const r = h.propose([{ do: "open", app: "terminal", folder }]);
  assert.equal(r.ok, true);
  h.untilBox();
  assert.equal(h.shown.length, 0, "no box for text that would be cut");
  const s = h.status(r.id);
  assert.equal(s.state, "refused");
  assert.equal(s.message, h.V.MSG.textTooLong);
});

test("the total text cap and the line cap are checked by buildBoxLines", () => {
  const { V } = makeHarness();
  // 40 steps cannot come through propose (12 at most), but the builder keeps its own cap.
  const many = { steps: new Array(40).fill({ do: "window", what: "close" }) };
  const close = { app: "other", workspace: 2, workspaceName: "2" };
  const closes = new Array(40).fill(close);
  assert.equal(V.buildBoxLines(many, { closes }).ok, false);
  const fine = { steps: new Array(12).fill({ do: "window", what: "close" }) };
  const r = V.buildBoxLines(fine, { closes: new Array(12).fill(close) });
  assert.equal(r.ok, true);
  assert.ok(r.lines.every((l) => l.text.length <= 120));
});

test("the same id twice is refused, also after the first one ended", () => {
  const h = makeHarness();
  const id = newId();
  const first = h.proposeText(h.request({ steps: ws2 }, { id }));
  assert.equal(first.ok, true);
  const second = h.proposeText(h.request({ steps: ws2 }, { id }));
  assert.equal(second.ok, false);
  assert.equal(second.message, h.V.MSG.idUsed);
  // End the first request with a no, then try the id again after the cool-down.
  h.untilBox();
  h.drawBox();
  h.desk.box.deny(h.now);
  h.tick(60000);
  const third = h.proposeText(h.request({ steps: ws2 }, { id }));
  assert.equal(third.message, h.V.MSG.idUsed);
});

test("sent_at 16 s old and 16 s ahead are refused, 15 s either way are fine", () => {
  const h = makeHarness();
  const mk = (delta) => h.request({ steps: ws2 }, { sent_at: h.now + delta });
  assert.equal(h.proposeText(mk(-16000)).message, h.V.MSG.wrongTime);
  h.tick(2500);
  assert.equal(h.proposeText(mk(16000)).message, h.V.MSG.wrongTime);
  h.tick(2500);
  assert.equal(h.proposeText(mk(-15000)).ok, true);
  const h2 = makeHarness();
  assert.equal(h2.proposeText(h2.request({ steps: ws2 }, { sent_at: h2.now + 15000 })).ok, true);
});

test("a finished record is kept for 10 minutes, then it is unknown", () => {
  const h = makeHarness();
  const r = h.propose(ws2);
  h.untilBox();
  h.drawBox();
  h.desk.box.deny(h.now);
  assert.equal(h.status(r.id).state, "denied");
  h.tick(599000);
  assert.equal(h.status(r.id).state, "denied");
  h.tick(2000);
  const s = h.status(r.id);
  assert.equal(s.state, "unknown");
  assert.equal(s.message, h.V.MSG.noRecord);
});

test("status answers unknown for ids that are not ids, without echoing them", () => {
  const h = makeHarness();
  for (const bad of ["", "x", "g".repeat(32), "A".repeat(32), "0".repeat(31), "$(id)"]) {
    const s = h.status(bad);
    assert.equal(s.state, "unknown");
    assert.equal(s.id, "");
  }
  assert.equal(h.status("0".repeat(32)).state, "unknown");
});

test("the 1,001st id makes the set forget the oldest", () => {
  const { M } = makeHarness();
  const seen = M.createSeenIds(1000);
  for (let i = 0; i < 1001; i++) seen.add("id" + i);
  assert.equal(seen.size(), 1000);
  assert.equal(seen.has("id0"), false);
  assert.equal(seen.has("id1"), true);
  assert.equal(seen.has("id1000"), true);
});

test("through propose: a forgotten id that comes back is just a new proposal", () => {
  const h = makeHarness();
  const firstId = newId();
  const bad = [];
  // An empty plan is refused after its id is recorded, which keeps this loop fast.
  const send = (id) => h.proposeText(h.request({ steps: bad }, { id }));
  assert.equal(send(firstId).message, h.V.MSG.noSteps);
  h.tick(4000);
  assert.equal(send(firstId).message, h.V.MSG.idUsed, "still remembered");
  for (let i = 0; i < 1000; i++) {
    h.tick(4000);
    send(newId());
  }
  h.tick(4000);
  const again = send(firstId);
  assert.notEqual(again.message, h.V.MSG.idUsed, "forgotten after more than 1,000 other ids");
  assert.equal(again.message, h.V.MSG.noSteps);
});

test("at most 50 records are kept, the oldest go first", () => {
  const { M, V } = makeHarness();
  const rec = M.createRecords(V);
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const id = i.toString(16).padStart(32, "0");
    ids.push(id);
    rec.create(id);
  }
  assert.equal(rec.count(), 50);
  assert.equal(JSON.parse(rec.json(ids[0], 0)).state, "unknown");
  assert.equal(JSON.parse(rec.json(ids[59], 0)).state, "pending");
});
