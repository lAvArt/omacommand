// Spec 11, test 1: forged requests are all refused with a fixed sentence that holds none of the input.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, makeHarness, newId } from "./helpers.mjs";

const forged = fixture("forged.json");

function assertFixedSentence(message, hostile, label) {
  assert.equal(typeof message, "string", label);
  assert.ok(message.length > 0 && message.length <= 400, label + ": length");
  assert.match(message, /^[\x20-\x7E]+$/, label + ": ASCII only");
  for (const bad of hostile) assert.ok(!message.includes(bad), label + ": the message repeats the input " + JSON.stringify(bad));
}

test("every forged plan is refused by validatePlan, and the message repeats nothing", () => {
  const { V } = makeHarness();
  assert.ok(forged.badPlans.length > 60);
  for (const c of forged.badPlans) {
    const r = V.validatePlan(c.plan);
    assert.equal(r.ok, false, c.name + " was accepted");
    assertFixedSentence(r.message, forged.hostile, c.name);
  }
});

test("a step with 13 entries is refused, 12 are fine", () => {
  const { V } = makeHarness();
  const step = { do: "workspace", to: 2 };
  assert.equal(V.validatePlan({ steps: new Array(12).fill(step) }).ok, true);
  assert.equal(V.validatePlan({ steps: new Array(13).fill(step) }).ok, false);
});

test("forged plans arriving through propose open no box and start no process", () => {
  for (const c of forged.badPlans) {
    const h = makeHarness();
    const r = h.proposeText(h.request(c.plan));
    assert.equal(r.ok, false, c.name);
    assert.equal(r.state, "refused", c.name);
    assertFixedSentence(r.message, forged.hostile, c.name);
    assert.equal(h.started.length, 0, c.name + ": a process was started");
    assert.equal(h.shown.length, 0, c.name + ": a box was shown");
  }
});

const goodPlan = { steps: [{ do: "workspace", to: 2 }] };

// Raw envelope texts. Each one is wrong in exactly one way.
function envelopeCases(h) {
  const id = newId();
  const base = { v: 1, id, sent_at: h.now, client: "test-agent", plan: goodPlan };
  const mk = (over) => JSON.stringify(Object.assign({}, base, over));
  const drop = (key) => { const o = Object.assign({}, base); delete o[key]; return JSON.stringify(o); };
  return [
    ["empty text", ""],
    ["not JSON", "not json at all"],
    ["an open brace", "{"],
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "42"],
    ["a string", "\"hello\""],
    ["v missing", drop("v")],
    ["v is 2", mk({ v: 2 })],
    ["v is a string", mk({ v: "1" })],
    ["v is a float", mk({ v: 1.5 })],
    ["v is true", mk({ v: true })],
    ["id is 31 characters", mk({ id: "a".repeat(31) })],
    ["id is 33 characters", mk({ id: "a".repeat(33) })],
    ["id is uppercase hex", mk({ id: "ABCDEF0123456789ABCDEF0123456789" })],
    ["id is not hex", mk({ id: "g".repeat(32) })],
    ["id is a number", mk({ id: 12345 })],
    ["id is null", mk({ id: null })],
    ["id missing", drop("id")],
    ["sent_at is a string", mk({ sent_at: "123" })],
    ["sent_at is a float", mk({ sent_at: h.now + 0.5 })],
    ["sent_at is negative", mk({ sent_at: -5 })],
    ["sent_at is zero", mk({ sent_at: 0 })],
    ["sent_at is null", mk({ sent_at: null })],
    ["sent_at is 1e309", JSON.stringify(base).replace(String(h.now), "1e309")],
    ["sent_at missing", drop("sent_at")],
    ["client is a number", mk({ client: 7 })],
    ["client is 33 characters", mk({ client: "c".repeat(33) })],
    ["client is null", mk({ client: null })],
    ["client is an array", mk({ client: ["x"] })],
    ["client missing", drop("client")],
    ["an extra key", mk({ extra: 1 })],
    ["an extra key named __proto__", JSON.stringify(base).replace("{", "{\"__proto__\":{\"x\":1},")],
    ["plan is an array", mk({ plan: [] })],
    ["plan is null", mk({ plan: null })],
    ["plan is a string", mk({ plan: "steps" })],
    ["plan missing", drop("plan")]
  ];
}

test("forged envelopes are all refused before anything starts", () => {
  const probe = makeHarness();
  const names = envelopeCases(probe).map((c) => c[0]);
  for (let i = 0; i < names.length; i++) {
    const h = makeHarness();
    const [name, text] = envelopeCases(h)[i];
    const r = h.proposeText(text);
    assert.equal(r.ok, false, name);
    assert.equal(r.state, "refused", name);
    assertFixedSentence(r.message, forged.hostile.concat(["not json", "ABCDEF", "gggg", "test-agent"]), name);
    assert.equal(h.started.length, 0, name + ": a process was started");
    assert.equal(h.shown.length, 0, name + ": a box was shown");
  }
});

test("a good envelope is accepted, so the refusals above are about the faults", () => {
  const h = makeHarness();
  const r = h.proposeText(h.request(goodPlan));
  assert.equal(r.ok, true);
  assert.match(r.id, /^[0-9a-f]{32}$/);
});
