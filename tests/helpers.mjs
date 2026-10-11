// Shared helpers for the tests: the real vocab.js and box_model.js, each in its own vm context (as QML gives each its own
// scope), and a desk with fake ports.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { loadContext, loadContexts, ROOT } from "../scripts/load_scripts.mjs";

export { ROOT, loadContext, loadContexts };

export function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", name), "utf8"));
}

// Counts the calls of JSON.parse inside a context (spec 11, test 2: oversized input must never reach the parser).
// The parse happens in the model's context (h.ctx), not in the vocabulary's.
export function installParseCounter(ctx) {
  vm.runInContext(
    "var __parseCalls = 0; (function () { var orig = JSON.parse; JSON.parse = function () { __parseCalls++; return orig.apply(JSON, arguments); }; })();",
    ctx
  );
  return () => ctx.__parseCalls;
}

// A small seeded generator, so a failing fuzz run can be repeated.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
export function newId() {
  idCounter++;
  return (idCounter.toString(16).padStart(8, "0") + "abcdef0123456789abcdef01").slice(0, 32);
}

// A window address as Hyprland writes it: 0x and 1 to 16 hex digits.
export function randomAddr(rnd) {
  const digits = 1 + Math.floor(rnd() * 16);
  let s = "0x";
  for (let i = 0; i < digits; i++) s += "0123456789abcdef"[Math.floor(rnd() * 16)];
  return s;
}

export function win(address, cls, extra) {
  return Object.assign({
    address, stableId: "sid-" + address, pid: 4000 + parseInt(address.slice(2), 16), cls, initialClass: cls,
    workspaceId: 1, workspaceName: "1", floating: false, fullscreen: false, focused: false, focusHistoryID: 5, mapped: true
  }, extra || {});
}

export function baseSnapshot() {
  return {
    monitor: { name: "eDP-1", dpms: true },
    screens: ["eDP-1"],
    activeAddress: "0xa1",
    activeWorkspace: 1,
    activeLayout: "dwindle",
    workspaces: [{ id: 1, layout: "dwindle" }],
    windows: [win("0xa1", "kitty", { focused: true, focusHistoryID: 0 })]
  };
}

// A desk wired to fake ports. Nothing here knows more than the real ports promise.
//
// The fake box window behaves like the real one (review C1, C10, C16):
//  - it sends a frame only when the model asked for one (requestFrame), never on its own: a box that does not change draws
//    nothing. Set h.autoFrames = false to deliver frames by hand.
//  - hiding it reports itself back (onVisibleChanged), once, like Qt's visible property does.
//  - h.finishOnKill = true makes killProcess find nothing running, which frees the slot from inside the call (review C7).
//  - h.onRefresh and h.onExec let a test change the fake desktop when the model refreshes or starts a command.
export function makeHarness() {
  const ctxs = loadContexts();
  const V = ctxs.vocab.VocabApi;
  const M = ctxs.model.ModelApi;
  const h = {
    ctx: ctxs.model, vctx: ctxs.vocab, V, M, now: 1_800_000_000_000,
    started: [], inflight: null, execs: [], kills: [], logWrites: [], logPath: null, shown: [], hidden: 0,
    welcomes: [], refreshes: 0, syncs: 0, snapshot: baseSnapshot(),
    env: { home: "/home/u", stateDir: "/home/u/.local/state/omacommand" },
    autoFrames: true, frameAsked: false, frameRequests: 0, windowVisible: false, hideReports: true,
    finishOnKill: false, onRefresh: null, onExec: null
  };
  const ports = {
    runProcess(argv) { h.started.push(argv); h.inflight = argv; },
    killProcess(hard) {
      h.kills.push(hard);
      if (h.finishOnKill && h.inflight) {
        h.inflight = null;
        h.desk.processDone({ code: -1, out: "" }, h.now);
      }
    },
    exec(argv) { h.execs.push(argv); if (h.onExec) h.onExec(argv); },
    snapshot() { return h.snapshot; },
    refresh() { h.refreshes++; if (h.onRefresh) h.onRefresh(); },
    requestFrame() { h.frameRequests++; h.frameAsked = true; },
    showBox(content, screen) { h.shown.push({ content, screen }); h.windowVisible = true; },
    hideBox() {
      h.hidden++;
      if (h.windowVisible) {
        h.windowVisible = false;
        if (h.hideReports) h.desk.box.visible(false, h.now);
      }
    },
    showWelcome(info) { h.welcomes.push(info); },
    writeLog(text) { h.logWrites.push(text); },
    logReady(p) { h.logPath = p; },
    env() { return h.env; },
    sync() { h.syncs++; }
  };
  h.desk = M.createDesk(V, ports);

  h.tick = (ms) => {
    h.now += ms;
    h.desk.tick(h.now);
    if (h.autoFrames && h.frameAsked) {
      h.frameAsked = false;
      h.desk.box.frame(h.now);
    }
  };
  h.request = (plan, over) => JSON.stringify(Object.assign({ v: 1, id: newId(), sent_at: h.now, client: "test-agent", plan }, over || {}));
  h.proposeText = (text) => JSON.parse(h.desk.propose(text, h.now));
  h.propose = (steps, over) => h.proposeText(h.request({ steps }, over));
  // Completes the process that is running now.
  h.answer = (out, code) => {
    const argv = h.inflight;
    if (!argv) throw new Error("no process is running");
    h.inflight = null;
    h.desk.processDone({ code: code === undefined ? 0 : code, out: out === undefined ? "" : out }, h.now);
    return argv;
  };
  // The usual answers of the tools the desk starts.
  h.autoAnswer = () => {
    const a = h.inflight;
    if (a[0] === "omarchy-shell") return h.answer("false\n", 0);
    if (a[0] === "realpath") return h.answer(a[a.length - 1] + "\n", 0);
    if (a[0] === "test") return h.answer("", 0);
    if (a[0] === "hyprctl") return h.answer("ok\n", 0);
    return h.answer("", 0);
  };
  // Runs preparation until the box is shown (or the request ended).
  h.untilBox = () => {
    for (let i = 0; i < 400 && h.shown.length === 0; i++) {
      if (h.inflight) h.autoAnswer();
      else h.tick(100);
      if (h.finished()) break;
    }
  };
  h.finished = () => !h.desk.needsTick();
  // The box is visible, sized and has drawn its first frame, in the order of the pilot on the real machine: the first frame
  // at about 45 ms, and the window becomes active a few ms AFTER it (review C1, C16). The window sends no other frame.
  h.drawBox = () => {
    h.desk.box.visible(true, h.now);
    h.desk.box.size(true, h.now);
    h.tick(45);
    h.desk.box.frame(h.now);
    h.tick(4);
    h.desk.box.active(true, h.now);
  };
  // The pointer arrives over Allow after the delay: it enters (the first position only sets the reference) and moves on,
  // then a click.
  h.clickAllow = () => {
    h.tick(1100);
    h.desk.box.pointerAt(296, 200, h.now);
    h.tick(10);
    h.desk.box.pointerAt(300, 200, h.now);
    h.tick(10);
    h.desk.box.press("mouse", h.now);
    h.tick(30);
    h.desk.box.release(true, h.now);
  };
  // After Allow: answers every process until the request ends.
  h.runAll = () => {
    for (let i = 0; i < 2000 && h.desk.needsTick(); i++) {
      if (h.inflight) h.autoAnswer();
      else h.tick(100);
    }
  };
  h.status = (id) => JSON.parse(h.desk.status(id, h.now));
  return h;
}

// ---------------------------------------------------------------- random plans, for the fuzz and the box-line tests
export function pick(rnd, list) { return list[Math.floor(rnd() * list.length)]; }

export function randomFolder(rnd) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
  const rest = chars + ".-";
  const name = () => {
    let s = chars[Math.floor(rnd() * chars.length)];
    const n = Math.floor(rnd() * 9);
    for (let i = 0; i < n; i++) s += rest[Math.floor(rnd() * rest.length)];
    return s;
  };
  const levels = Math.floor(rnd() * 5);
  if (levels === 0) return "~";
  const parts = [];
  for (let i = 0; i < levels; i++) parts.push(name());
  return (rnd() < 0.5 ? "~/" : "") + parts.join("/");
}

function validValue(rnd, field) {
  if (field.kind === "int") return field.min + Math.floor(rnd() * (field.max - field.min + 1));
  if (field.kind === "bool") return rnd() < 0.5;
  if (field.kind === "enum") return pick(rnd, field.values);
  return randomFolder(rnd);
}

// One step that validateStep accepts.
export function validStep(rnd, V) {
  for (let tries = 0; tries < 200; tries++) {
    const kind = pick(rnd, Object.keys(V.STEP_SPECS));
    const spec = V.STEP_SPECS[kind];
    const step = { do: kind };
    for (const name of Object.keys(spec.fields)) {
      if (!spec.required.includes(name) && rnd() < 0.5) continue;
      step[name] = validValue(rnd, spec.fields[name]);
    }
    if (V.validateStep(step, 1).ok) return step;
  }
  throw new Error("no valid step found");
}

const LEAVES = [null, true, false, 0, 1, 2, 10, 11, -1, 1.5, 1e309, "2", "", "terminal", "left", "wider", "small", "tiled", "~/x", "x", "close", "float", "$(id)", "__proto__", "constructor", "0x1f", "a".repeat(80)];
const KEYS = ["do", "to", "app", "direction", "place", "folder", "follow", "change", "amount", "mode", "what", "title", "window", "steps", "__proto__", "constructor", "x"];

function setKey(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true }); }

export function randomJson(rnd, depth = 0) {
  const r = rnd();
  if (depth > 3 || r < 0.5) return LEAVES[Math.floor(rnd() * LEAVES.length)];
  if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomJson(rnd, depth + 1));
  const o = {};
  const n = Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) setKey(o, KEYS[Math.floor(rnd() * KEYS.length)], randomJson(rnd, depth + 1));
  return o;
}

// A plan for the fuzz: sometimes all valid, sometimes with one thing wrong or random JSON in the steps.
export function randomPlan(rnd, V) {
  const r = rnd();
  if (r < 0.1) return randomJson(rnd);
  const clean = rnd() < 0.5; // half of the plans are fully valid, the rest carry a few faults
  const count = 1 + Math.floor(rnd() * (clean ? 12 : 13));
  const steps = [];
  for (let i = 0; i < count; i++) {
    let step = validStep(rnd, V);
    const m = clean ? 1 : rnd() * 5;
    if (m < 0.2) {
      const keys = Object.keys(step);
      const k = keys[Math.floor(rnd() * keys.length)];
      step = Object.assign({}, step);
      if (rnd() < 0.5) delete step[k]; else setKey(step, k, randomJson(rnd, 2));
    } else if (m < 0.25) {
      step = randomJson(rnd);
    } else if (m < 0.3) {
      step = Object.assign({}, step);
      setKey(step, KEYS[Math.floor(rnd() * KEYS.length)], randomJson(rnd, 2));
    }
    steps.push(step);
  }
  const plan = { steps };
  if (!clean && rnd() < 0.05) setKey(plan, "title", "hello");
  return plan;
}
