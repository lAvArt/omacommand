// Spec 11, test 7: Lua is only built from typed templates. 100,000 random plans, and every hole of the wrong type.
import test from "node:test";
import assert from "node:assert/strict";
import { makeHarness, mulberry32, randomAddr, randomPlan } from "./helpers.mjs";

const { V } = makeHarness();
const NAMES = Object.keys(V.LUA_TEMPLATES);

// Pieces that must never be in a Lua string (spec 5.3).
const FORBIDDEN = ["exec", "eval", "os.", "io.", "load", "require", "..", "[[", "--", "\\", "'", ";", "\n", "\r"];

function assertSafeLua(s, label) {
  assert.equal(typeof s, "string", label);
  assert.ok(s.length <= 200, label + ": length " + s.length);
  assert.match(s, /^hl\.dsp\.[a-z_.]+\(/, label);
  for (const piece of FORBIDDEN) assert.ok(!s.includes(piece), label + ": contains " + JSON.stringify(piece) + " in " + s);
  const matching = NAMES.filter((n) => V.LUA_REGEXES[n].test(s));
  assert.equal(matching.length, 1, label + ": matches " + matching.length + " templates: " + s);
  return matching[0];
}

const GOOD = { ws: 7, dir: "r", bool: true, addr: "0x1f2e3d", px: -300 };

function goodHoles(name) {
  const t = V.LUA_TEMPLATES[name];
  const h = {};
  for (const [k, type] of Object.entries(t.holes)) h[k] = GOOD[type];
  return h;
}

// Values that are wrong for each hole type.
const WRONG = {
  ws: [0, 11, -1, 1.5, NaN, Infinity, "2", "02", null, undefined, true, [], {}, "2; os.exit()", 2n],
  dir: ["left", "", "lr", "x", "L", 1, null, undefined, [], {}, "l;", "l\n"],
  bool: ["true", "false", 1, 0, null, undefined, "", [], {}],
  addr: ["0x", "0xZZ", "1f", "0X1f", "0x1F", "0x" + "1".repeat(17), " 0x1f", "0x1f ", "0x1f\n", "0x1f\")--", null, 5, [], {}, "address:0x1f", undefined],
  px: [50, 101, 1500, -50, 1.5, "100", NaN, Infinity, null, "-100", [], {}, undefined]
};

test("every template builds from good holes, matches exactly its own regex, and passes the guard", () => {
  const seenNames = new Set();
  for (const name of NAMES) {
    const s = V.lua(name, goodHoles(name));
    assert.equal(assertSafeLua(s, name), name);
    seenNames.add(name);
  }
  assert.equal(seenNames.size, 18);
  assert.equal(V.lua("focus_ws", { ws: 3 }), 'hl.dsp.focus({ workspace = "3" })');
  assert.equal(V.lua("resize", { x: -100, y: 0, addr: "0xab" }), 'hl.dsp.window.resize({ x = -100, y = 0, relative = true, window = "address:0xab" })');
  assert.equal(V.lua("preselect", { dir: "d" }), 'hl.dsp.layout("preselect d")');
});

test("lua() throws on every hole of the wrong type", () => {
  let checked = 0;
  for (const name of NAMES) {
    const t = V.LUA_TEMPLATES[name];
    for (const [hole, type] of Object.entries(t.holes)) {
      for (const bad of WRONG[type]) {
        const holes = goodHoles(name);
        holes[hole] = bad;
        assert.throws(() => V.lua(name, holes), undefined, name + "." + hole + " = " + String(bad));
        checked++;
      }
    }
  }
  assert.ok(checked > 100);
});

test("lua() throws on a missing hole, an extra hole, and an unknown template", () => {
  for (const name of NAMES) {
    const good = goodHoles(name);
    const keys = Object.keys(good);
    for (const k of keys) {
      const missing = Object.assign({}, good);
      delete missing[k];
      assert.throws(() => V.lua(name, missing), undefined, name + " without " + k);
    }
    assert.throws(() => V.lua(name, Object.assign({}, good, { extra: 1 })), undefined, name + " with an extra hole");
  }
  for (const bad of ["", "nope", "__proto__", "constructor", "toString", "hasOwnProperty", 5, null, undefined, ["focus_ws"]]) {
    assert.throws(() => V.lua(bad, { ws: 1 }), undefined, String(bad));
  }
});

test("the final guard refuses what a template could never produce", () => {
  for (const bad of [
    "", "hl.dsp.focus({ workspace = \"1\" }); os.exit()", "os.execute('x')", "hl.dsp.exec_cmd(\"x\")", "hl.dsp.focus({ x = 1 }) -- x",
    "hl.dsp.focus({ x = 'a' })", "hl.dsp.focus({})\nx", "hl.dsp.focus({ x = [[a]] })", "hl.dsp.focus({ a = b..c })", "hl.dsp.load(x)",
    "hl.dsp.focus(require(x))", "hl.dsp.focus(\\x)", "x.hl.dsp.focus({})", "hl.dsp.focus({" + "a".repeat(200) + "})", 5, null
  ]) {
    assert.equal(V.luaGuard(bad), false, String(bad).slice(0, 40));
  }
  assert.equal(V.luaGuard('hl.dsp.focus({ workspace = "1" })'), true);
});

test("100,000 random plans: every Lua string matches exactly one template and holds nothing forbidden", () => {
  const rnd = mulberry32(20261011);
  const used = new Set();
  let accepted = 0;
  let stringsBuilt = 0;
  for (let n = 0; n < 100000; n++) {
    const plan = randomPlan(rnd, V);
    const r = V.validatePlan(plan);
    if (!r.ok) continue;
    accepted++;
    for (const step of r.plan.steps) {
      const folderReal = "folder" in step ? "/home/u/" + V.folderRel(step.folder) : undefined;
      const ops = V.planOps(step, { folderReal: folderReal && folderReal.endsWith("/") ? folderReal.slice(0, -1) : folderReal });
      for (const op of ops) {
        // A different window address every time: 1 to 16 hex digits, as Hyprland gives them (review C16).
        const addr = randomAddr(rnd);
        if (op.t === "lua") {
          const s = V.luaFor(op, addr);
          if (op.win) assert.ok(s.includes('"address:' + addr + '"'), s);
          used.add(assertSafeLua(s, "plan " + n));
          stringsBuilt++;
        } else if (op.t === "open" && op.place) {
          used.add(assertSafeLua(V.preselectLua(op.place), "plan " + n + " preselect"));
          stringsBuilt++;
        } else if (op.t === "close") {
          const s = V.lua("close", { addr });
          assert.ok(s.includes('"address:' + addr + '"'), s);
          used.add(assertSafeLua(s, "plan " + n + " close"));
          stringsBuilt++;
        }
      }
    }
  }
  assert.ok(accepted > 15000, "only " + accepted + " plans were accepted");
  assert.ok(stringsBuilt > 30000, "only " + stringsBuilt + " strings were built");
  // Every template that a step can reach was produced at least once.
  assert.deepEqual([...used].sort(), NAMES.slice().sort());
});

test("a random JSON value in any field of a step never gets through validatePlan as something else", () => {
  const rnd = mulberry32(99);
  // The accepted copy only ever holds the known fields with checked values.
  for (let n = 0; n < 20000; n++) {
    const r = V.validatePlan(randomPlan(rnd, V));
    if (!r.ok) continue;
    assert.ok(Object.isFrozen(r.plan) && Object.isFrozen(r.plan.steps));
    for (const s of r.plan.steps) {
      assert.ok(Object.isFrozen(s));
      for (const k of Object.keys(s)) assert.ok(k === "do" || k in V.STEP_SPECS[s.do].fields, k);
    }
  }
});
