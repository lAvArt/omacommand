// The tables the code decides by are frozen at load (review C12), the terminal entry of the catalogue (review C15), and the
// two script files keep to their own scope, as QML gives it to them (review C16).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makeHarness } from "./helpers.mjs";

// A RegExp is not frozen on purpose (see deepFreeze in vocab.js); the table that holds it is.
function assertDeepFrozen(o, label) {
  if (o === null || typeof o !== "object") return;
  if (Object.prototype.toString.call(o) === "[object RegExp]") return;
  assert.ok(Object.isFrozen(o), label + " is not frozen");
  for (const k of Object.keys(o)) assertDeepFrozen(o[k], label + "." + k);
}

const TABLES = ["APPS", "HOLE_TYPES", "LUA_TEMPLATES", "DESKTOP_CMDS", "WINDOW_CMDS", "LAYOUT_CMD", "SYSTEM_CMDS", "SYSTEM_TRACKED", "SPOTIFY_CHECK"];

test("LUA_TEMPLATES, HOLE_TYPES, APPS and the argv tables are deeply frozen at load (review C12)", () => {
  const { V } = makeHarness();
  for (const name of TABLES) {
    assert.ok(V[name] !== undefined, name + " is exported");
    assertDeepFrozen(V[name], name);
  }
  // The lookups the catalogue does with its RegExp still work.
  assert.equal(V.appForClass("kitty"), "terminal");
});

test("writes to the frozen tables have no effect, in the sloppy mode that QML scripts and vm scripts run in (review C12)", () => {
  const h = makeHarness();
  const before = {
    lua: h.V.lua("focus_ws", { ws: 3 }),
    resize: h.V.lua("resize", { x: 100, y: -200, addr: "0xab" }),
    terminal: Array.from(h.V.appArgv("terminal")),
    spotify: Array.from(h.V.appArgv("spotify")),
    volume: Array.from(h.V.planOps({ do: "system", what: "volume_up" })[0].argv),
    words: h.V.stepWords({ do: "open", app: "terminal" }),
    snapshot: JSON.stringify(TABLES.map((n) => h.V[n]))
  };
  const thrown = vm.runInContext(
    [
      "var tries = [",
      "  function () { VocabApi.APPS.terminal.name = 'Evil'; },",
      "  function () { VocabApi.APPS.terminal.folder = false; },",
      "  function () { VocabApi.APPS.terminal.cls = /.*/; },",
      "  function () { VocabApi.APPS.extra = { name: 'x' }; },",
      "  function () { delete VocabApi.APPS.btop; },",
      "  function () { VocabApi.HOLE_TYPES.ws.pat = '.*'; },",
      "  function () { VocabApi.HOLE_TYPES.ws.enc = function () { return '9'; }; },",
      "  function () { VocabApi.HOLE_TYPES.px.enc = function () { return '999999'; }; },",
      "  function () { VocabApi.HOLE_TYPES.evil = { pat: '.*', enc: function (v) { return v; } }; },",
      "  function () { VocabApi.LUA_TEMPLATES.focus_ws.text = 'os.execute(1)'; },",
      "  function () { VocabApi.LUA_TEMPLATES.focus_ws.holes.ws = 'px'; },",
      "  function () { VocabApi.LUA_TEMPLATES.evil = { text: 'x', holes: {} }; },",
      "  function () { delete VocabApi.LUA_TEMPLATES.close; },",
      "  function () { VocabApi.SYSTEM_CMDS.mute.push('--evil'); },",
      "  function () { VocabApi.SYSTEM_CMDS.mute[0] = 'evil'; },",
      "  function () { VocabApi.SYSTEM_CMDS.evil = ['x']; },",
      "  function () { VocabApi.SYSTEM_TRACKED.lock = true; },",
      "  function () { VocabApi.DESKTOP_CMDS.gaps[0] = 'evil'; },",
      "  function () { VocabApi.WINDOW_CMDS.pop_out.length = 0; },",
      "  function () { VocabApi.LAYOUT_CMD[0] = 'evil'; },",
      "  function () { VocabApi.LAYOUT_CMD.pop(); },",
      "  function () { VocabApi.SPOTIFY_CHECK[2] = '/bin/evil'; }",
      "];",
      "var thrown = 0;",
      "for (var i = 0; i < tries.length; i++) { try { tries[i](); } catch (e) { thrown++; } }",
      "thrown;"
    ].join("\n"),
    h.vctx
  );
  assert.equal(typeof thrown, "number");
  assert.equal(h.V.lua("focus_ws", { ws: 3 }), before.lua);
  assert.equal(h.V.lua("resize", { x: 100, y: -200, addr: "0xab" }), before.resize);
  assert.deepEqual(Array.from(h.V.appArgv("terminal")), before.terminal);
  assert.deepEqual(Array.from(h.V.appArgv("spotify")), before.spotify);
  assert.deepEqual(Array.from(h.V.planOps({ do: "system", what: "volume_up" })[0].argv), before.volume);
  assert.equal(h.V.stepWords({ do: "open", app: "terminal" }), before.words);
  assert.equal(JSON.stringify(TABLES.map((n) => h.V[n])), before.snapshot, "no table changed");
  assert.throws(() => h.V.lua("evil", {}), undefined, "no template was added");
  assert.throws(() => h.V.lua("focus_ws", { ws: 11 }), undefined, "the hole types still check");
  assert.equal(h.V.appForClass("kitty"), "terminal", "the RegExp of the catalogue was not swapped");
  assert.equal(h.V.appForClass("anything"), "other");
});

test("the terminal entry takes the class names of foot that Omarchy's own window rule lists, and those of its terminals (review C15)", () => {
  const { V } = makeHarness();
  // Omarchy 4.0.4 offers alacritty, foot, ghostty and kitty (omarchy-install-terminal), and foot runs under either app id.
  for (const cls of ["foot", "Foot", "footclient", "FOOTCLIENT", "org.codeberg.dnkl.foot", "org.codeberg.dnkl.footclient", "Org.Codeberg.Dnkl.Foot",
    "Alacritty", "kitty", "com.mitchellh.ghostty", "ghostty"]) {
    assert.equal(V.appForClass(cls), "terminal", cls);
  }
  for (const cls of ["org.codeberg.dnkl.foot2", "org.codeberg.dnkl", "org.codeberg.dnkl.footclients", "xfoot", "foot ", " foot", "footclient2", "foo", "org-codeberg-dnkl-foot", ""]) {
    assert.equal(V.appForClass(cls), "other", JSON.stringify(cls));
  }
});

test("the Obsidian entry takes both of its app ids: the old one and that of its desktop file (pilot F)", () => {
  const { V } = makeHarness();
  for (const cls of ["obsidian", "Obsidian", "md.obsidian.Obsidian", "MD.OBSIDIAN.OBSIDIAN"]) assert.equal(V.appForClass(cls), "obsidian", cls);
  for (const cls of ["md.obsidian", "md-obsidian-Obsidian", "md.obsidian.Obsidian2", "xobsidian", " obsidian", ""]) {
    assert.equal(V.appForClass(cls), "other", JSON.stringify(cls));
  }
});

test("box_model.js sees nothing of vocab.js's globals and the other way round: QML gives each its own scope (review C16)", () => {
  const h = makeHarness();
  for (const name of ["hasOwn", "isObj", "asciiLine", "cleanLine", "MSG", "LIMITS", "APPS", "deepFreeze", "VocabApi", "validatePlan", "lua", "stepWords"]) {
    assert.equal(vm.runInContext("typeof " + name, h.ctx), "undefined", name + " is visible in the model's scope");
  }
  for (const name of ["createDesk", "createBoxModel", "ModelApi", "BOX_DELAY_MS", "RUN_TIMEOUT_MS"]) {
    assert.equal(vm.runInContext("typeof " + name, h.vctx), "undefined", name + " is visible in the vocabulary's scope");
  }
  assert.equal(vm.runInContext("typeof ModelApi", h.ctx), "object");
  assert.equal(vm.runInContext("typeof VocabApi", h.vctx), "object");
});
