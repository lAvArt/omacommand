// Spec 11, test 6: injection and invisible characters, the folder rules, and the text of the box lines.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, makeHarness, mulberry32, randomPlan, randomFolder } from "./helpers.mjs";

const folders = fixture("folders.json");
const { V } = makeHarness();

// The ranges of spec 4, written as numbers.
const RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x115f],
  [0x1160, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0xe0000, 0xe01ef]
];

test("cleanLine strips every code point of the spec 4 ranges", () => {
  let count = 0;
  for (const [lo, hi] of RANGES) {
    for (let cp = lo; cp <= hi; cp++) {
      const ch = String.fromCodePoint(cp);
      assert.equal(V.cleanLine("a" + ch + "b"), "a b", "U+" + cp.toString(16));
      assert.equal(V.cleanLine(ch + "x" + ch), "x", "U+" + cp.toString(16) + " at both ends");
      count++;
    }
  }
  assert.ok(count > 600, "checked " + count + " code points");
});

test("cleanLine strips lone surrogates and keeps ordinary text", () => {
  assert.equal(V.cleanLine("a" + String.fromCharCode(0xd800) + "b"), "a b");
  assert.equal(V.cleanLine("a" + String.fromCharCode(0xdfff) + "b"), "a b");
  assert.equal(V.cleanLine("  Hello,   world.  "), "Hello, world.");
  assert.equal(V.cleanLine("tab\tand\nnewline"), "tab and newline");
  assert.equal(V.cleanLine("abcdef", 3), "abc");
  assert.equal(V.cleanLine(undefined), "");
  assert.equal(V.cleanLine(null), "");
});

test("asciiLine output is always printable ASCII, whatever goes in", () => {
  const rnd = mulberry32(7);
  const eAcute = String.fromCharCode(0xe9);
  const arabic = String.fromCharCode(0x627, 0x644);
  const samples = ["", "plain", "caf" + eAcute, String.fromCodePoint(0x1f600), String.fromCodePoint(0x202e) + "txt", arabic];
  for (let i = 0; i < 3000; i++) {
    let s = "";
    const n = Math.floor(rnd() * 12);
    for (let j = 0; j < n; j++) {
      const r = rnd();
      s += r < 0.3 ? String.fromCharCode(Math.floor(rnd() * 128)) : r < 0.8 ? String.fromCharCode(Math.floor(rnd() * 0x10000)) : String.fromCodePoint(Math.floor(rnd() * 0x10ffff));
    }
    samples.push(s);
  }
  for (const s of samples) {
    const out = V.asciiLine(s);
    assert.match(out, /^[\x20-\x7E]*$/, JSON.stringify(s));
    assert.ok(!/^ | $/.test(out) && !/ {2}/.test(out), "trimmed and collapsed: " + JSON.stringify(out));
  }
  assert.equal(V.asciiLine("caf" + eAcute), "caf?");
  assert.equal(V.asciiLine("plain text"), "plain text");
  assert.equal(V.asciiLine("a".repeat(500), 120).length, 120);
});

test("the folder strings of the fixture are all refused", () => {
  for (const f of folders.refused) {
    assert.equal(V.FOLDER_RE.test(f), false, JSON.stringify(f));
    const r = V.validatePlan({ steps: [{ do: "open", app: "terminal", folder: f }] });
    assert.equal(r.ok, false, JSON.stringify(f));
  }
});

test("unicode lookalikes, 67-character names and five levels are refused", () => {
  for (const cps of folders.lookalikeCodePoints) {
    const s = String.fromCodePoint(...cps);
    assert.equal(V.FOLDER_RE.test(s), false, JSON.stringify(cps));
    assert.equal(V.FOLDER_RE.test("~/" + s), false, JSON.stringify(cps) + " under home");
    assert.equal(V.FOLDER_RE.test("ok/" + s + "/ok"), false, JSON.stringify(cps) + " in the middle");
  }
  assert.equal(V.FOLDER_RE.test("a".repeat(67)), false);
  assert.equal(V.FOLDER_RE.test("a".repeat(66)), false);
  assert.equal(V.FOLDER_RE.test("a".repeat(65)), false);
  assert.equal(V.FOLDER_RE.test("a".repeat(64)), true, "the longest name");
  assert.equal(V.FOLDER_RE.test("~/" + "a".repeat(67)), false);
  assert.equal(V.FOLDER_RE.test("a/b/c/d/e"), false);
  assert.equal(V.FOLDER_RE.test("a/b/c/d"), true);
});

test("the folder strings that should work are accepted and shown with ~/", () => {
  for (const f of folders.accepted) {
    assert.equal(V.FOLDER_RE.test(f), true, f);
    const shown = V.displayRel(V.folderRel(f));
    assert.match(shown, /^~(\/[A-Za-z0-9._-]+)*$/);
  }
  assert.equal(V.displayRel(V.folderRel("~")), "~");
  assert.equal(V.displayRel(V.folderRel("Development/prj")), "~/Development/prj");
  assert.equal(V.displayRel(V.folderRel("~/Development/prj")), "~/Development/prj");
});

test("a folder that resolves outside the home folder, or into a hidden one, is refused", () => {
  const home = "/home/u";
  assert.equal(V.checkRealFolder(home, "/home/u").ok, true);
  assert.equal(V.checkRealFolder(home, "/home/u/Development/prj").ok, true);
  assert.equal(V.checkRealFolder(home, "/home/u/Work/prj").rel, "Work/prj");
  for (const bad of ["/etc", "/home/user2/x", "/home/u2", "/home/u/.ssh", "/home/u/a/.hidden", "/home/u/a//b", "/home/u/a/../b",
    "/home/u/a b\nc", "/home/u/x\"y", "/home/u/x\\y", "", "relative/path", "/home/u/" + "a".repeat(5000)]) {
    assert.equal(V.checkRealFolder(home, bad).ok, false, JSON.stringify(bad.slice(0, 40)));
  }
  assert.equal(V.checkRealFolder("/home/../etc", "/home/../etc/x").ok, false, "an unsafe home");
  assert.equal(V.checkRealFolder("", "/x").ok, false);
});

test("home must be absolute with no dot parts and no odd characters", () => {
  assert.equal(V.isSafeHome("/home/u"), true);
  assert.equal(V.isSafeHome("/home/u/"), false);
  assert.equal(V.isSafeHome("home/u"), false);
  assert.equal(V.isSafeHome("/home/../u"), false);
  assert.equal(V.isSafeHome("/home/./u"), false);
  assert.equal(V.isSafeHome("/home/u v"), false);
  assert.equal(V.isSafeHome("/home/u\n"), false);
  assert.equal(V.isSafeHome("/"), false);
  assert.equal(V.isSafeHome(undefined), false);
});

test("the numbered lines of every accepted plan are ASCII, at most 120 characters, and come from the template list", () => {
  const rnd = mulberry32(2024);
  let built = 0;
  let tooLong = 0;
  for (let n = 0; n < 4000; n++) {
    const r = V.validatePlan(randomPlan(rnd, V));
    if (!r.ok) continue;
    const folderPrep = [];
    const closePrep = [];
    r.plan.steps.forEach((s, i) => {
      if (s.do === "open" && "folder" in s) {
        const rel = V.folderRel(s.folder);
        folderPrep[i] = { real: "/home/u" + (rel ? "/" + rel : ""), shown: V.displayRel(rel), link: rnd() < 0.3 ? V.displayRel(V.folderRel(randomFolder(rnd))) : null };
      }
      if (s.do === "window" && s.what === "close") {
        closePrep[i] = { app: rnd() < 0.5 ? "other" : V.APP_KEYS[Math.floor(rnd() * V.APP_KEYS.length)], workspace: 1 + Math.floor(rnd() * 10), workspaceName: "" };
      }
    });
    const b = V.buildBoxLines(r.plan, { folders: folderPrep, closes: closePrep });
    if (!b.ok) { tooLong++; continue; }
    built++;
    assert.ok(b.lines.length >= 1 && b.lines.length <= 12);
    b.lines.forEach((line, i) => {
      assert.match(line.text, /^[\x20-\x7E]{1,120}$/);
      const m = /^(\d+)\. (.*)$/.exec(line.text);
      assert.ok(m && Number(m[1]) === i + 1, "numbered: " + line.text);
      assert.ok(V.WORD_PATTERNS.some((p) => p.test(m[2])), "not from the template list: " + line.text);
    });
  }
  assert.ok(built > 500, "only " + built + " plans were built");
  assert.ok(tooLong >= 0);
});

test("validatePlan accepts its own frozen output unchanged, which is what the run relies on (spec 5.7)", () => {
  const rnd = mulberry32(5150);
  let checked = 0;
  for (let n = 0; n < 5000; n++) {
    const first = V.validatePlan(randomPlan(rnd, V));
    if (!first.ok) continue;
    const second = V.validatePlan(first.plan);
    assert.equal(second.ok, true);
    assert.equal(JSON.stringify(second.plan), JSON.stringify(first.plan));
    assert.ok(Object.isFrozen(second.plan) && second.plan !== first.plan);
    checked++;
  }
  assert.ok(checked > 800);
});

test("a close line names the app and the workspace and warns about unsaved work", () => {
  const step = { do: "window", what: "close", app: "vscode" };
  const words = V.stepWords(step, { close: { app: "vscode", workspace: 2, workspaceName: "2" } });
  assert.equal(words, "Close the VS Code window on workspace 2 (unsaved work in it may be lost)");
  const other = V.stepWords({ do: "window", what: "close" }, { close: { app: "other", workspace: 4, workspaceName: "4" } });
  assert.equal(other, "Close a window of an app that is not on Omacommand's list, on workspace 4 (unsaved work in it may be lost)");
  const r = V.buildBoxLines({ steps: [step] }, { closes: [{ app: "vscode", workspace: 2, workspaceName: "2" }] });
  assert.equal(r.hasClose, true);
  assert.equal(r.lines[0].urgent, true);
});

test("a folder line shows the folder quoted and, for a link, where it really opens", () => {
  const step = { do: "open", app: "terminal", folder: "~/Development/prj" };
  assert.equal(V.stepWords(step, { folder: { shown: "~/Development/prj", link: null } }), 'Open Terminal in "~/Development/prj"');
  assert.equal(
    V.stepWords(step, { folder: { shown: "~/Development/prj", link: "~/Work/prj" } }),
    'Open Terminal in "~/Development/prj" (a link to "~/Work/prj")'
  );
});

test("box text never contains agent text: the only variable parts are numbers, catalogue words and a checked folder", () => {
  const plan = V.validatePlan({ steps: [{ do: "workspace", to: 2 }, { do: "open", app: "vscode" }] }).plan;
  const b = V.buildBoxLines(plan, {});
  assert.deepEqual(Array.from(b.lines, (l) => l.text), ["1. Go to workspace 2", "2. Open VS Code"]);
  assert.equal(V.BOX_TITLE, "An AI agent on this computer wants to:");
  assert.equal(V.BOX_FOOTER, "Nothing runs until you click Allow. Esc or Deny means no.");
});

test("the connect command is built from a path that is safe to paste", () => {
  const home = "/home/u";
  const base = "/home/u/.config/omarchy/plugins/io.github.lavart.omacommand/mcp/server.rb";
  assert.equal(V.safeServerPath("file://" + base, home), base);
  assert.equal(V.safeServerPath("file:///opt/omarchy-plugins/x/mcp/server.rb", home), "/opt/omarchy-plugins/x/mcp/server.rb");
  // Anything odd falls back to the usual place under home.
  for (const odd of ["file:///home/u/my%20plugins/x/mcp/server.rb", "file:///home/u/a;b/mcp/server.rb", "file:///home/u/../etc/mcp/server.rb",
    "http://example.invalid/mcp/server.rb", "", undefined, "file:///home/u/x/mcp/server.rb%0A", "%E0%A4%A"]) {
    assert.equal(V.safeServerPath(odd, home), base, String(odd));
  }
  assert.equal(V.safeServerPath("file:///home/u/my%20plugins/x/mcp/server.rb", "relative"), "", "no safe home, no path");
  assert.equal(JSON.parse(V.NOT_READY).ready, false);
});

test("the agent's self-reported name reaches the log only if it is plain", () => {
  assert.equal(V.logClient("claude-code"), 'client="claude-code" (self-reported)');
  assert.equal(V.logClient("My Agent 1.2"), 'client="My Agent 1.2" (self-reported)');
  assert.equal(V.logClient("evil" + String.fromCharCode(27) + "[31m"), "client=unknown");
  assert.equal(V.logClient(""), "client=unknown");
  assert.equal(V.logClient("a".repeat(33)), "client=unknown");
  assert.equal(V.logClient("<script>"), "client=unknown");
});
