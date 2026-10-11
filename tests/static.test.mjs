// Spec 11, test 11: static checks over the files of the repo, and the marketplace wording rules of spec 9.
// Words the scanner flags are built from pieces here, so this file passes the scan it describes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, loadContext } from "./helpers.mjs";
import { toolsText } from "../scripts/build_tools.mjs";

const J = (...parts) => parts.join("");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error("symbolic link in the repo: " + p);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const FILES = walk(ROOT);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const read = (p) => fs.readFileSync(p, "utf8");
const SHIPPED = FILES.filter((p) => !rel(p).startsWith("tests/")); // code and docs that users get
const CODE = SHIPPED.filter((p) => /\.(qml|js|rb|mjs)$/.test(p));
const ctx = loadContext();
const V = ctx.VocabApi;

// ---------------------------------------------------------------- the files themselves (spec 9.2, 9.3)
test("the files needed by spec 13 D are all there", () => {
  const names = FILES.map(rel);
  for (const f of ["manifest.json", "vocab.js", "box_model.js", "Service.qml", "AllowBox.qml", "WelcomeBox.qml", "mcp/server.rb", "mcp/tools.json",
    "scripts/build_tools.mjs", "README.md", "SECURITY.md", "LICENSE", "CHANGELOG.md"]) {
    assert.ok(names.includes(f), "missing " + f);
  }
  assert.ok(names.some((n) => n.startsWith("tests/") && n.endsWith(".test.mjs")));
  assert.ok(names.some((n) => n.startsWith("tests/fixtures/") && n.endsWith(".json")));
});

// NOTE on the executable bit: on Windows every file reads as mode 0o666, so this check always passes there, and git on
// Windows may record any mode it likes. The release step checks the modes git will publish, in a clone or on Linux:
//   git ls-files -s    (every line must start with 100644, none with 100755)
// Fix a wrong one with: git update-index --chmod=-x <file>   (review C16)
test("no file is over 512 KiB, the total is under 8 MiB, fewer than 1,000 files, no executable bits", () => {
  let total = 0;
  for (const p of FILES) {
    const st = fs.statSync(p);
    assert.ok(st.size < 512 * 1024, rel(p) + " is " + st.size + " bytes");
    assert.equal(st.mode & 0o111, 0, rel(p) + " is executable");
    total += st.size;
  }
  assert.ok(total < 8 * 1024 * 1024);
  assert.ok(FILES.length < 1000);
});

test("exactly one manifest.json, at the root", () => {
  const manifests = FILES.filter((p) => path.basename(p) === "manifest.json").map(rel);
  assert.deepEqual(manifests, ["manifest.json"]);
});

test("no file or folder name has install, installer, setup or uninstall as a part", () => {
  const re = /(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)/i;
  for (const p of FILES) {
    for (const part of rel(p).split("/")) assert.ok(!re.test(part), rel(p));
  }
});

test("the manifest is the one of spec 9.3: a service and nothing else", () => {
  const m = JSON.parse(read(path.join(ROOT, "manifest.json")));
  assert.deepEqual(m.kinds, ["service"]);
  assert.deepEqual(m.entryPoints, { service: "Service.qml" });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.id, "io.github.lavart.omacommand");
  assert.equal(m.name, "Omacommand");
  assert.equal(m.author, J("lAv", "Art"));
  assert.equal(m.license, "MIT");
  assert.equal(m.version, V.VERSION);
  assert.ok(m.description.length <= 500);
  assert.deepEqual(Object.keys(m).sort(), ["author", "description", "entryPoints", "id", "kinds", "license", "name", "schemaVersion", "version"]);
  for (const k of ["keepLoaded", "activation", "overlay", "panel", "menu", "barWidget"]) assert.ok(!(k in m), k);
  assert.ok(fs.existsSync(path.join(ROOT, m.entryPoints.service)));
});

test("the version is the same in the manifest, vocab.js, the server and the changelog", () => {
  const server = read(path.join(ROOT, "mcp", "server.rb"));
  assert.match(server, new RegExp('VERSION = "' + V.VERSION.replace(/\./g, "\\.") + '"'));
  assert.match(read(path.join(ROOT, "CHANGELOG.md")), new RegExp("## " + V.VERSION.replace(/\./g, "\\.") + " "));
  assert.equal(V.PLUGIN_ID, "io.github.lavart.omacommand");
});

test("no hidden, invisible or bidi characters in any file, and the code files are plain ASCII", () => {
  const bad = new RegExp("[" + String.fromCharCode(0, 8) + String.fromCharCode(11, 12) + String.fromCharCode(14, 31) + String.fromCharCode(127) + "]");
  for (const p of FILES) {
    const text = read(p);
    assert.ok(!bad.test(text), rel(p) + " has a control character");
    const invisible = new RegExp("[" + [0xad, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
      .map((c) => String.fromCharCode(c)).join("") + "]");
    assert.ok(!invisible.test(text), rel(p) + " has an invisible character");
  }
  for (const p of CODE.concat(FILES.filter((f) => f.endsWith(".json") || f.endsWith(".mjs")))) {
    assert.ok(!/[^\x00-\x7F]/.test(read(p)), rel(p) + " has non-ASCII characters");
  }
});

// ---------------------------------------------------------------- QML structure (spec 3.1, 11.11)
// Replaces comments and strings with spaces, so braces and keywords can be scanned safely.
function scrub(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      out += "  ";
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  ";
      i++;
    } else if (c === '"' || c === "'") {
      out += " ";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") { out += " "; i++; }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
    } else {
      out += c;
    }
  }
  return out;
}

// Returns {start, end} of the body of the first `Name {` block at or after `from` (indexes inside the braces).
function blockOf(clean, name, from = 0) {
  const m = new RegExp("(^|[^\\w.])" + name + "\\s*\\{").exec(clean.slice(from));
  assert.ok(m, "no " + name + " block");
  const open = from + m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  throw new Error("unbalanced " + name);
}

// Lines of a block body that sit directly inside it (brace depth 0 inside the body).
function topLevelLines(clean, block) {
  const body = clean.slice(block.start, block.end);
  const lines = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 0 && line.trim() !== "") lines.push(line.trim());
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return lines;
}

const service = read(path.join(ROOT, "Service.qml"));
const serviceClean = scrub(service);

test("braces are balanced in every QML and JS file", () => {
  for (const p of FILES.filter((f) => /\.(qml|js)$/.test(f))) {
    const clean = scrub(read(p));
    let depth = 0;
    for (const ch of clean) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      assert.ok(depth >= 0, rel(p));
    }
    assert.equal(depth, 0, rel(p));
  }
});

test("the IpcHandler declares exactly four functions and no properties", () => {
  const ipc = blockOf(serviceClean, "IpcHandler");
  const top = topLevelLines(serviceClean, ipc);
  const functions = top.filter((l) => /^function\b/.test(l));
  assert.deepEqual(
    functions.map((l) => /^function (\w+)\(([^)]*)\): (\w+)/.exec(l).slice(1, 4).join("|")),
    ["ping||string", "propose|request: string|string", "status|id: string|string", "state||string"]
  );
  assert.ok(!top.some((l) => /\b(property|signal)\b/.test(l)), "a property or signal in the IpcHandler");
  assert.ok(top.some((l) => /^target:/.test(l)));
  // The body text (strings kept) names the target and each function wraps its work in try and catch.
  const raw = service.slice(service.indexOf("IpcHandler {"));
  assert.ok(raw.includes('target: "' + V.PLUGIN_ID + '"'));
  assert.equal((raw.slice(0, raw.indexOf("AllowBox {")).match(/\btry \{/g) || []).length, 4);
});

test("the service root declares no functions, properties or signals, and none of the injected properties", () => {
  const root = blockOf(serviceClean, "Item");
  const top = topLevelLines(serviceClean, root);
  for (const l of top) {
    assert.ok(!/^(function|property|readonly|required|default|signal)\b/.test(l), "root declares: " + l);
    assert.ok(!/^(shell|pluginRegistry|manifest|omarchyPath|barWidgetRegistry)\s*:/.test(l), "root sets: " + l);
  }
  assert.ok(top.some((l) => /^id: root/.test(l)));
  assert.ok(!/\bproperty\s+\w+\s+(shell|pluginRegistry|manifest|omarchyPath|barWidgetRegistry)\b/.test(serviceClean), "an injected property is declared");
  // The service has one Item root and nothing before the imports but imports.
  assert.match(service, /^import [^\n]+\n(import [^\n]+\n)*\n(\/\/[^\n]*\n)*Item \{/);
});

test("the manifest's service is the only entry point, and no other QML file is a panel, overlay or menu kind", () => {
  for (const f of ["AllowBox.qml", "WelcomeBox.qml"]) {
    const clean = scrub(read(path.join(ROOT, f)));
    assert.match(clean, /^\s*(import [^\n]+\n)+\s*PanelWindow \{/m, f + " is a PanelWindow");
  }
  assert.ok(!/\b(OverlayWindow|ConfirmDialog|BarWidget|KeyboardPanel|PanelController)\b/.test(FILES.map((p) => scrub(read(p))).filter((t, i) => /\.qml$/.test(FILES[i])).join("\n")));
});

test("QML imports are fixed names: no computed paths, no Loader", () => {
  for (const p of FILES.filter((f) => f.endsWith(".qml"))) {
    const text = read(p);
    for (const line of text.split("\n").filter((l) => /^\s*import\b/.test(l))) {
      assert.match(line, /^import (QtQuick(\.Window)?|Quickshell(\.(Io|Hyprland|Wayland))?|qs\.Commons as Commons|"(vocab|box_model)\.js" as \w+)$/, rel(p) + ": " + line);
    }
    assert.ok(!/\bLoader\b/.test(scrub(text)), rel(p) + " uses a Loader");
  }
});

test("QML never reads a file: FileView only writes, and its read settings are off", () => {
  for (const p of FILES.filter((f) => f.endsWith(".qml"))) {
    const clean = scrub(read(p));
    assert.ok(!/\btext\(\)/.test(clean), rel(p) + " calls text()");
    assert.ok(!/\bdata\(\)/.test(clean), rel(p) + " calls data()");
    assert.ok(!/preload:\s*true/.test(clean), rel(p) + " preloads");
    assert.ok(!/\bblockLoading\b/.test(clean) && !/\bwatchChanges:\s*true/.test(clean));
  }
  let from = 0;
  let views = 0;
  for (;;) {
    const m = /(^|[^\w.])FileView\s*\{/.exec(serviceClean.slice(from));
    if (!m) break;
    const block = blockOf(serviceClean, "FileView", from);
    const body = serviceClean.slice(block.start, block.end);
    for (const setting of ["preload: false", "watchChanges: false", "printErrors: false"]) assert.ok(body.includes(setting), "FileView without " + setting);
    from = block.end;
    views++;
  }
  assert.equal(views, 2);
});

test("the QML writes only the log and the welcome marker, and runs only what the model asks for", () => {
  const writes = serviceClean.match(/\.setText\(/g) || [];
  assert.equal(writes.length, 2);
  assert.ok(!/\.(write|writeText|saveText)\(/.test(serviceClean.replace(/\.setText\(/g, "")));
  // The model decides every command. The one exception is the Copy button of the welcome box.
  const literal = service.match(/Quickshell\.execDetached\(\s*\[[^\]]*\]/g) || [];
  assert.equal(literal.length, 1, "a command written into the QML: " + literal.join(" | "));
  assert.ok(literal[0].includes('"wl-copy"'));
  assert.ok(!/command:\s*\[/.test(serviceClean), "a Process command written into the QML");
});

// ---------------------------------------------------------------- forbidden code (spec 11.11, 6.2)
const FORBIDDEN_CODE = [
  /ShellIpc/, /IpcRegistry/, /XMLHttpRequest/, /WebSocket/, /openUrlExternally/, /exec_cmd/, /exec_raw/,
  /\beval\b/, /--batch/, /\bFunction\(/, /createQmlObject/
];

test("none of the forbidden code patterns appears in anything that ships", () => {
  for (const p of SHIPPED) {
    const text = read(p);
    for (const re of FORBIDDEN_CODE) assert.ok(!re.test(text), rel(p) + " contains " + re);
  }
});

test("vocab.js and box_model.js are plain scripts that QML and vm can both load", () => {
  for (const f of ["vocab.js", "box_model.js"]) {
    const text = scrub(read(path.join(ROOT, f)));
    assert.ok(!/^\s*(import|export)\b/m.test(text), f + ": module syntax");
    assert.ok(!/module\.exports|\.pragma|\.import\b/.test(text), f);
    assert.ok(!/\brequire\s*\(/.test(text), f + ": require()");
    assert.ok(!/=>/.test(text), f + ": arrow function");
    assert.ok(!/^\s*(let|const|class)\s/m.test(text), f + ": let, const or class at the start of a line");
    assert.ok(!/\b(let|const)\s+\w+\s*=/.test(text), f + ": let or const");
    assert.ok(!text.includes("`"), f + ": template literal");
    assert.ok(!/\b(XMLHttpRequest|fetch|Worker|setTimeout|setInterval|process)\b/.test(text), f + ": a runtime API that QML lacks");
  }
});

test("every .js and .mjs file passes node --check", () => {
  const files = FILES.filter((f) => /\.(js|mjs)$/.test(f));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    assert.equal(r.status, 0, rel(f) + ": " + r.stderr);
  }
});

// ---------------------------------------------------------------- the Ruby server (spec 7.1, 11.11)
const server = read(path.join(ROOT, "mcp", "server.rb"));

test("the Ruby server loads only json, open3 and securerandom, and has no network or shell calls", () => {
  const requires = [...server.matchAll(/^\s*require\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(requires, ["json", "open3", "securerandom"]);
  const bad = [
    new RegExp(J("soc", "ket"), "i"), /net\//, /open-uri/, /resolv/, /`/, /%x/, /\bsystem\s*\(/, /\bexec\s*\(/, /\bspawn\s*\(/, /\bKernel\.(exec|system|spawn)\b/,
    /\bIO\.popen\b/, /\bPTY\b/, /\bProcess\.(spawn|exec|daemon)\b/, /\bFile\.(write|binwrite|delete|unlink|rename|chmod|symlink)\b/, /\bIO\.(write|binwrite)\b/,
    /\bFileUtils\b/, /\bENV\[[^\]]*\]\s*=/, /\b(instance_eval|class_eval|module_eval|send|public_send|constantize)\b/, /\bMarshal\b/, /\bYAML\b/, /\bJSON\.load\b/, /create_additions:\s*true/
  ];
  for (const re of bad) assert.ok(!re.test(server), "server.rb matches " + re);
});

test("Open3 and Child.run are only ever given arrays", () => {
  const open3 = [...server.matchAll(/Open3\.(\w+)\(([^)]*)\)/g)];
  assert.equal(open3.length, 1, "one place starts processes");
  assert.equal(open3[0][1], "popen3");
  assert.match(open3[0][2], /^\*argv\b/, "popen3 gets the argv array splatted");
  assert.match(server, /raise ArgumentError[^\n]*unless argv\.is_a\?\(Array\) && argv\.length >= 2/);
  const calls = [...server.matchAll(/Child\.run\(([^)]*\)?)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 3);
  for (const c of calls) assert.match(c, /^(argv|\["omarchy-shell"|\["git")/, c);
});

test("the Ruby server runs as the plugin's interpreter flags say, and takes no settings from the environment", () => {
  const envUses = [...server.matchAll(/ENV(?:\[|\.fetch\()"([A-Z_]+)"/g)].map((m) => m[1]).sort();
  // Read only, for the --check output and for finding the log. Nothing here changes what the server does for an agent.
  assert.deepEqual([...new Set(envUses)], ["HOME", "OMARCHY_PATH", "PATH", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"]);
  assert.match(server, /^# frozen_string_literal: true/);
  assert.match(server, /--disable=gems,rubyopt/);
});

test("the connect command appears only in the README and in the welcome text", () => {
  const word = J("claude", " ", "mcp");
  const where = FILES.filter((p) => read(p).includes(word)).map(rel).sort();
  assert.deepEqual(where, ["README.md", "WelcomeBox.qml"]);
});

// ---------------------------------------------------------------- tools.json (spec 7.2)
test("mcp/tools.json is exactly what scripts/build_tools.mjs writes from vocab.js", () => {
  const onDisk = read(path.join(ROOT, "mcp", "tools.json")).replace(/\r\n/g, "\n");
  assert.equal(onDisk, toolsText(V));
  const tools = JSON.parse(onDisk).tools;
  assert.deepEqual(tools.map((t) => t.name), ["propose_desk_plan", "desk_plan_result", "desk_state"]);
  const steps = tools[0].inputSchema.properties.steps;
  assert.equal(steps.maxItems, V.LIMITS.maxSteps);
  assert.deepEqual([...steps.items.properties.do.enum], Object.keys(V.STEP_SPECS));
  assert.equal(steps.items.additionalProperties, false);
  assert.ok(tools[0].description.includes("The person sees exactly these steps and must click Allow. If they say no, do not ask again for the same thing unless they ask you to."));
  for (const app of V.APP_KEYS) assert.ok(tools[0].description.includes(app));
});

// ---------------------------------------------------------------- marketplace wording (spec 9.1, 10.4)
test("the two privilege words appear only in the two allowed sentences", () => {
  const word = new RegExp(J("su", "do") + "|" + J("pk", "exec"), "i");
  const allowed = [J("It does not use su", "do or pk", "exec."), J("Omacommand does not use su", "do.")];
  let found = 0;
  for (const p of FILES) {
    for (const line of read(p).split("\n")) {
      if (!word.test(line)) continue;
      found++;
      let rest = line;
      for (const a of allowed) rest = rest.split(a).join("");
      assert.ok(!word.test(rest), rel(p) + ": " + line.trim());
    }
  }
  assert.ok(found >= 2, "the sentence should be in the README and in SECURITY.md");
  for (const f of ["README.md", "SECURITY.md"]) {
    assert.ok(read(path.join(ROOT, f)).includes(allowed[0]), f + " lacks the sentence");
  }
  // Never in code comments.
  for (const p of CODE) assert.ok(!word.test(read(p)), rel(p));
});

test("none of the other scanner words appears in any file", () => {
  const words = [
    J("system", "ctl"), J("systemd", "-run"), J("npm ", "install"), J("pnpm ", "add"), J("yarn ", "add"), J("bun ", "add"),
    J("gem ", "install"), J("pip ", "install"), J("pacman ", "-S"), J("cargo ", "install"), J("go ", "install"), J("brew ", "install"),
    J("omarchy pkg", " add")
  ];
  const patterns = [
    /\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b/i,
    /\b(npm|pnpm|yarn|bun)\s+(install|add)\b/i,
    /\b(pip3?|gem|cargo|go|brew)\s+install\b/i
  ];
  for (const p of FILES) {
    const text = read(p);
    const lower = text.toLowerCase();
    for (const w of words) assert.ok(!lower.includes(w.toLowerCase()), rel(p) + " contains " + w);
    for (const re of patterns) assert.ok(!re.test(text), rel(p) + " matches " + re);
  }
});

test("no private names or personal data, and every mention of the organisation is one of the four allowed forms", () => {
  const privateWords = [
    J("Lat", "if"), J("info", "@"), J("lav", "artstudio"), J("tailc", "2c030"), J("ts", ".net"), J("Key", "Finder"), J("You", "sef"),
    J("lav", "art-lap"), J("ai-pro-", "assistant"), J("Command", "Centre"), J("command", "-centre"), J("cc", "-run"), J("cc", "gate"),
    J(".local", "/bin"), J("Hij", "ri"), J("/home/", "lav", "art"), J("D:", "/Development"), J("her", "dr"), J("Tail", "scale"), J("gm", "ail")
  ];
  for (const p of FILES) {
    const lower = read(p).toLowerCase();
    for (const w of privateWords) assert.ok(!lower.includes(w.toLowerCase()), rel(p) + " contains a private word");
    assert.ok(!/\bhub\b/i.test(read(p)), rel(p) + " mentions a private term");
  }
  const allowed = [
    "io.github.lavart.omacommand", "github.com/lAvArt/omacommand", "Copyright (c) 2026 lAvArt", '"author": "lAvArt"'
  ];
  let hits = 0;
  for (const p of FILES) {
    let text = read(p);
    for (const a of allowed) text = text.split(a).join("");
    const m = new RegExp(J("lav", "art"), "i").exec(text);
    assert.ok(!m, rel(p) + ": the organisation name outside the four allowed forms near " + JSON.stringify(m ? text.slice(Math.max(0, m.index - 30), m.index + 30) : ""));
    hits++;
  }
  assert.ok(hits > 10);
  // The only e-mail address in the repo, if any, is a GitHub noreply address.
  for (const p of FILES) {
    for (const m of read(p).matchAll(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      assert.ok(m[0].endsWith("@users.noreply.github.com"), rel(p) + ": " + m[0]);
    }
  }
});

test("the README and SECURITY.md carry the 'What Allow proves' paragraph word for word", () => {
  const paragraph = [
    "**What Allow proves, and what it does not.** Omacommand protects you from an AI agent whose only way to reach your desktop is",
    "Omacommand. Such an agent can only propose steps from a fixed list, you see exactly those steps, and nothing runs until you click",
    "Allow. Allow does not protect you from programs that already have full use of your account. If your agent can run terminal",
    "commands, or change files outside its project, without asking you first, it can control your desktop directly, change Omacommand",
    "itself, or even click Allow for you, and no box on the screen can stop that. For the strongest setup, let your agent use",
    "Omacommand freely, but make it ask you before every terminal command and every file change outside its project. Omacommand",
    J("makes no network connection. It does not use su", "do or pk", "exec.")
  ].join(" ");
  for (const f of ["README.md", "SECURITY.md"]) {
    const text = read(path.join(ROOT, f)).replace(/\r\n/g, "\n").replace(/\n(?!\n)/g, " ").replace(/ +/g, " ");
    assert.ok(text.includes(paragraph.replace(/ +/g, " ")), f + " does not hold the paragraph exactly");
  }
});

test("README has setup in two steps, how to remove it, and the dependencies; no build notes", () => {
  const readme = read(path.join(ROOT, "README.md"));
  assert.match(readme, /Step 1/);
  assert.match(readme, /Step 2/);
  assert.match(readme, /## Remove it/);
  assert.ok(readme.includes("omarchy plugin remove " + V.PLUGIN_ID));
  assert.match(readme, /~\/\.local\/state\/omacommand/);
  assert.match(readme, /--disable=gems,rubyopt/);
  assert.match(readme, /--check/);
  assert.ok(!/Notes for the build/i.test(readme));
  for (const dep of ["Omarchy", "Hyprland", "Ruby", "git", "wl-clipboard", "uwsm"]) assert.ok(readme.includes(dep), dep);
  assert.match(readme, /rev-parse HEAD/);
  assert.match(readme, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/);
});

test("LICENSE is MIT with the right holder", () => {
  const text = read(path.join(ROOT, "LICENSE"));
  assert.match(text, /^MIT License\n/);
  assert.ok(text.includes("Copyright (c) 2026 lAvArt"));
  assert.match(text, /Permission is hereby granted, free of charge/);
});

// ---------------------------------------------------------------- the review fixes that can only be checked in the files
// There is no qmllint or Quickshell on the machine that runs these tests, so the QML side of the fixes is guarded by what the
// files say. The rules themselves are tested through box_model.js, with a fake window.
const allowBox = read(path.join(ROOT, "AllowBox.qml"));
const allowClean = scrub(allowBox);

test("AllowBox.qml counts only the two synthesized sources as touch; any other source is a mouse (review C9)", () => {
  assert.match(allowClean, /Qt\.MouseEventSynthesizedByQt/);
  assert.match(allowClean, /Qt\.MouseEventSynthesizedBySystem/);
  assert.ok(!/MouseEventNotSynthesized/.test(allowClean), "comparing with 'not synthesized' would make an unknown source a touch");
});

test("AllowBox.qml reports the global pointer position, has no centred card, and reserves the hint row and the footer (review C2)", () => {
  assert.match(allowClean, /mapToGlobal\(/);
  assert.match(allowClean, /box\.pointerAt\(/);
  assert.ok(!/box\.pointer\(/.test(allowClean), "the old unconditional pointer report is gone");
  // The card (not the labels inside the buttons) hangs from a fixed line instead of being centred on its content.
  const card = allowClean.slice(allowClean.indexOf("id: card"), allowClean.indexOf("id: col"));
  assert.ok(card.length > 50 && !/centerIn/.test(card), "the card must not be centred on its content");
  assert.match(card, /y: Math\.max\(24, /);
  assert.match(allowBox, /Item \{\s*width: col\.width\s*height: 56/, "the footer has a fixed height");
  assert.match(allowBox, /Item \{\s*width: col\.width\s*height: 36/, "the hint row has a fixed height");
});

test("AllowBox.qml forces keyboard focus when the box becomes visible and when its window becomes active (review C8)", () => {
  assert.match(allowClean, /Qt\.callLater\(function \(\) \{ scrim\.forceActiveFocus\(\) \}\)/);
  assert.match(allowClean, /onVisibleChanged:[\s\S]*?focusScrim\(\)/);
  assert.match(allowClean, /function onActiveChanged\(\)[\s\S]*?focusScrim\(\)/);
});

test("the model's request for a frame ends in the window's update() (review C1)", () => {
  assert.match(allowClean, /function requestFrame\(\)[\s\S]*?\.update\(\)/);
  assert.match(serviceClean, /requestFrame: function \(\) \{ allowBox\.requestFrame\(\) \}/);
});

test("Service.qml frees the process slot when Quickshell emits no exit (review C7)", () => {
  assert.match(serviceClean, /onRunningChanged:\s*\{\s*if \(!proc\.running\) engine\.procLost\(\)\s*\}/);
  assert.match(serviceClean, /function killProc[\s\S]*?if \(!proc\.running\) procLost\(\)/);
  assert.match(serviceClean, /function procLost\(\)[\s\S]*?procFinish\(\)/);
});

test("the Ruby server stops polling with the worst case of one call left, and never says 'nothing ran' for a failed last poll (review C13, C14)", () => {
  assert.match(server, /STATUS_WORST = 7/);
  assert.match(server, /deadline - Clock\.now - POLL_SECONDS < STATUS_WORST/);
  assert.ok(!/return lost_message\(seen\) if misses/.test(server));
  const end = server.slice(server.indexOf("def window_end_message"), server.indexOf("# Plain sentences the agent can repeat"));
  assert.match(end, /NO_ANSWER_LAST/);
  assert.match(end, /desk_plan_result with id/);
  assert.ok(!/Nothing ran/.test(end));
  assert.match(server, /NO_ANSWER_LAST = "[^"]*did not answer the last check[^"]*"/);
  assert.match(server, /OMARCHY_PATH is not set : /);
  assert.match(server, /Could not check whether Omacommand's files were changed/);
});

test(".gitattributes keeps LF line endings, and the word a privilege pattern may match is nowhere (review C17)", () => {
  assert.equal(read(path.join(ROOT, ".gitattributes")).replace(/\r\n/g, "\n"), "* text=auto eol=lf\n");
  const word = new RegExp(J("pol", "kit"), "i");
  for (const p of FILES) assert.ok(!word.test(read(p)), rel(p));
});

test("the README says what steps do, what place needs, how to read the version and why a folder may be refused (review C18)", () => {
  const readme = read(path.join(ROOT, "README.md")).replace(/\r\n/g, "\n").replace(/\n(?!\n)/g, " ").replace(/ +/g, " ");
  assert.ok(readme.includes("only what Omarchy's own keys do, including the state they keep"));
  assert.ok(!readme.includes("changing your settings or files"));
  assert.match(readme, /needs the tiled layout/);
  assert.ok(readme.includes("log -1 --format='%H %cs %s'"));
  assert.match(readme, /home folder is itself a link/);
  assert.ok(readme.includes("a few small files"));
  assert.ok(!/does nothing/.test(readme), "no step silently does nothing");
  assert.ok(!/playerctl|wpctl|brightnessctl/.test(readme), "the tools of the old argv are gone");
  assert.match(readme, /Spotify/);
  assert.match(readme, /never adds software/);
  // The changelog carries the review fixes.
  assert.match(read(path.join(ROOT, "CHANGELOG.md")), /Code review/);
});
