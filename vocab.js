// Omacommand vocabulary: the one place that knows which desktop steps exist (spec 4, 5).
//
// This is a plain script. QML imports it as it is, and the tests load the same bytes with vm.runInNewContext.
// So: no module syntax, no .pragma, and only ES5 plus Number.isInteger and Object.freeze, which Qt's JS engine has.
// Top level uses var and function declarations only, so a test context sees them as globals. Callers use VocabApi.

var PLUGIN_ID = "io.github.lavart.omacommand";
var VERSION = "1.0.0";

var LIMITS = {
  maxRequestChars: 16384, // spec 3.5
  maxNesting: 8,
  maxSteps: 12,
  maxLineChars: 120, // spec 3.2
  maxTotalChars: 2000,
  maxClientChars: 32,
  maxSkewMs: 15000, // spec 6.3
  maxIds: 1000,
  maxRecords: 50,
  recordKeepMs: 600000,
  maxClients: 256,
  maxWindowsPerWorkspace: 32,
  maxWindowsTotal: 128
};

// Every fixed sentence the service says. None of them contains caller input (spec 4, 7.5).
var MSG = {
  tooLarge: "The request is too large.",
  badRequest: "The request could not be understood.",
  wrongTime: "The time in the request is not right.",
  idUsed: "That request id was already used.",
  busy: "Another request is waiting for the person, or running. Try again after it ends.",
  welcomeOpen: "Omacommand is showing its welcome note. Try again in a moment.",
  rate: "Too many requests. Wait a few seconds.",
  invalidPause: "Too many requests that Omacommand cannot run. Wait a minute.",
  stateRate: "Asked too often. Wait a second.",
  locked: "The screen is locked, so no box can be shown. Nothing ran.",
  lockUnknown: "Omacommand could not tell whether the screen is locked, so no box was shown. Nothing ran.",
  noScreen: "No screen is ready to show the box. Nothing ran.",
  denied: "The person said no. Nothing ran.",
  timeout: "The person did not answer within 45 seconds. Nothing ran.",
  windowClosed: "A window in the request was closed. Nothing ran.",
  internal: "Omacommand had an internal error. Nothing ran.",
  internalRunning: "Omacommand had an internal error. Some steps may have run; call desk_state to see the desktop now.",
  textTooLong: "The text of the request is too long to show. Nothing ran.",
  noRecord: "Omacommand has no record of that request.",
  waiting: "Waiting for the person to answer.",
  running: "The steps are running.",
  planShape: "The plan must be an object with a list of steps.",
  planField: "The plan has a field Omacommand does not know.",
  noSteps: "The plan has no steps.",
  tooManySteps: "A plan can have at most 12 steps.",
  gone: "That window is already closed.",
  changed: "That window is no longer the same window.",
  cannotTell: "that window cannot be told apart from the others yet. Try again in a moment.",
  spotifyMissing: "Spotify is not installed.",
  windowChangedWhilePreparing: "A window in the request changed while it was prepared. Try again."
};

function paused(minutes) {
  return "Omacommand is paused for " + minutes + " more " + (minutes === 1 ? "minute" : "minutes") +
    " because the person said no several times.";
}

var INTERNAL_PROPOSE = JSON.stringify({ v: 1, ok: false, state: "refused", message: MSG.internal });
var INTERNAL_PLAIN = JSON.stringify({ v: 1, ok: false, message: MSG.internal });
var NOT_READY = JSON.stringify({ v: 1, ready: false, message: "Omacommand did not start. Look at the Omarchy shell log." });

// ---------------------------------------------------------------- small helpers

function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function isObj(v) { return v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]"; }
function sm(n, text) { return "Step " + n + ": " + text; }
function fail(message) { return { ok: false, message: message }; }

// Freezes an object and everything inside it. A RegExp is left alone: freezing one gains nothing (its pattern cannot be
// changed) and a frozen lastIndex could trip an engine that writes it. The table that holds a RegExp is frozen, so the
// RegExp cannot be swapped.
function deepFreeze(o) {
  if (o !== null && typeof o === "object" && Object.prototype.toString.call(o) !== "[object RegExp]") {
    Object.freeze(o);
    var ks = Object.keys(o);
    for (var i = 0; i < ks.length; i++) deepFreeze(o[ks[i]]);
  }
  return o;
}

// ---------------------------------------------------------------- text cleaning (spec 4)
// No \p{} here: Qt's JS engine may not support it. Written with code units so surrogate pairs work.
// The ranges of spec 4, as numbers. The pattern is built at load time so no source file has to hold invisible characters.
var CLEAN_RANGES = [
  [0x0000, 0x001F], [0x007F, 0x009F], [0x00AD, 0x00AD], [0x034F, 0x034F], [0x061C, 0x061C], [0x115F, 0x115F],
  [0x1160, 0x1160], [0x17B4, 0x17B5], [0x180B, 0x180F], [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x206F],
  [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0], [0xFFF0, 0xFFFB]
];
function unitEsc(n) { return String.fromCharCode(92) + "u" + ("0000" + n.toString(16).toUpperCase()).slice(-4); }
function buildCleanRe() {
  var src = "[";
  for (var i = 0; i < CLEAN_RANGES.length; i++) {
    src += unitEsc(CLEAN_RANGES[i][0]);
    if (CLEAN_RANGES[i][1] !== CLEAN_RANGES[i][0]) src += "-" + unitEsc(CLEAN_RANGES[i][1]);
  }
  // U+E0000 to U+E01EF as surrogate pairs, then any other surrogate.
  src += "]|" + unitEsc(0xDB40) + "[" + unitEsc(0xDC00) + "-" + unitEsc(0xDDEF) + "]|[" + unitEsc(0xD800) + "-" + unitEsc(0xDFFF) + "]";
  return new RegExp(src, "g");
}
var CLEAN_RE = buildCleanRe();
var NOT_ASCII_RE = /[^\x20-\x7E]/g;

function cleanLine(s, max) {
  var t = String(s === undefined || s === null ? "" : s).replace(CLEAN_RE, " ").replace(/\s+/g, " ").replace(/^ +| +$/g, "");
  return max > 0 ? t.slice(0, max) : t;
}

// Everything shown in the box or written to the log goes through this. All vocabulary words are ASCII, so nothing real changes.
function asciiLine(s, max) {
  var t = cleanLine(s, 0).replace(NOT_ASCII_RE, "?");
  return max > 0 ? t.slice(0, max) : t;
}

// ---------------------------------------------------------------- the app catalogue (spec 5.2)
// Window classes and launch commands are those of Omarchy 4.0.4. Classes are only matched, never shown.
var APP_KEYS = ["terminal", "browser", "files", "vscode", "obsidian", "spotify", "btop"];
var APPS = {
  // foot also runs under org.codeberg.dnkl.foot, and footclient is its client; Omarchy's own terminal window rule lists both.
  terminal: { name: "Terminal", folder: true, reuse: false, cls: /^(kitty|alacritty|ghostty|com\.mitchellh\.ghostty|foot|org\.codeberg\.dnkl\.foot(client)?|footclient|org\.kde\.konsole)$/i },
  browser: { name: "Browser", folder: false, reuse: true, cls: /^(chromium|chromium-browser|brave-browser|google-chrome|firefox|org\.mozilla\.firefox|zen|vivaldi-stable|microsoft-edge)$/i },
  files: { name: "Files", folder: true, reuse: false, cls: /^org\.gnome\.nautilus$/i },
  vscode: { name: "VS Code", folder: true, reuse: true, cls: /^(com\.microsoft\.vscode|code)$/i },
  obsidian: { name: "Obsidian", folder: false, reuse: true, cls: /^obsidian$/i },
  spotify: { name: "Spotify", folder: false, reuse: true, cls: /^spotify$/i },
  btop: { name: "btop", folder: false, reuse: true, cls: /^org\.omarchy\.btop$/i }
};
deepFreeze(APPS);
var APP_LIST_TEXT = APP_KEYS.join(", ");

function appForClass(cls) {
  if (typeof cls !== "string") return "other";
  for (var i = 0; i < APP_KEYS.length; i++) {
    if (APPS[APP_KEYS[i]].cls.test(cls)) return APP_KEYS[i];
  }
  return "other";
}

// The folder is always absolute, so it can never be read as an option (spec 5.4).
function appArgv(app, folderReal) {
  if (folderReal !== undefined && !isSafeRealPath(folderReal)) throw new Error("appArgv: bad folder");
  switch (app) {
    case "terminal":
      return folderReal ? ["uwsm-app", "--", "xdg-terminal-exec", "--dir=" + folderReal] : ["omarchy-launch-terminal"];
    case "browser":
      return ["omarchy-launch-browser"];
    case "files":
      return folderReal ? ["uwsm-app", "--", "nautilus", "--new-window", folderReal] : ["omarchy-launch-nautilus"];
    case "vscode":
      return folderReal ? ["uwsm-app", "--", "code", "--new-window", folderReal] : ["uwsm-app", "--", "code", "--new-window"];
    case "obsidian":
      return ["uwsm-app", "--", "obsidian"];
    case "spotify":
      // Never Omarchy's own launcher for it: when Spotify is missing, that one starts a program that adds software (review C3).
      return ["uwsm-app", "--", "spotify"];
    case "btop":
      return ["omarchy-launch-tui", "btop"];
  }
  throw new Error("appArgv: unknown app");
}

// Other commands, one argv array each (spec 5.2). Nothing is joined into a string. All of these tables are frozen at load.
var DESKTOP_CMDS = deepFreeze({
  nightlight: ["omarchy-toggle-nightlight"],
  gaps: ["omarchy-hyprland-window-gaps-toggle"]
});
var WINDOW_CMDS = deepFreeze({
  pop_out: ["omarchy-hyprland-window-pop"],
  transparency: ["omarchy-hyprland-window-transparency-toggle"]
});
var LAYOUT_CMD = deepFreeze(["omarchy-hyprland-workspace-layout-toggle"]);
// The volume, brightness and music steps are exactly what Omarchy 4.0.4's own keys run (default/hypr/bindings/media.lua).
var SYSTEM_CMDS = deepFreeze({
  lock: ["omarchy-system-lock"],
  volume_up: ["omarchy-audio-output-volume", "raise"],
  volume_down: ["omarchy-audio-output-volume", "lower"],
  mute: ["omarchy-audio-output-volume", "mute-toggle"],
  brightness_up: ["omarchy-brightness-display", "+5%"],
  brightness_down: ["omarchy-brightness-display", "5%-"],
  play_pause: ["omarchy-shell", "media", "playPause"],
  next_track: ["omarchy-shell", "media", "next"],
  previous_track: ["omarchy-shell", "media", "previous"],
  show_time: ["omarchy-notification-time"],
  show_battery: ["omarchy-notification-battery"]
});
// These short system steps run as the tracked process, so their exit code is known and a failure is reported.
var SYSTEM_TRACKED = deepFreeze({
  volume_up: true, volume_down: true, mute: true, brightness_up: true, brightness_down: true,
  play_pause: true, next_track: true, previous_track: true
});
// Asked before a box with an "open Spotify" step is shown: the app must be there, because nothing here adds software.
var SPOTIFY_CHECK = deepFreeze(["test", "-x", "/usr/bin/spotify"]);

// ---------------------------------------------------------------- folders (spec 5.4)
var FOLDER_NAME = "[A-Za-z0-9_][A-Za-z0-9._-]{0,63}";
var FOLDER_RE = new RegExp("^(?:~|(?:~/)?" + FOLDER_NAME + "(?:/" + FOLDER_NAME + "){0,3})$");

function folderRel(f) {
  if (f === "~") return "";
  return f.indexOf("~/") === 0 ? f.slice(2) : f;
}
function displayRel(rel) { return rel === "" ? "~" : "~/" + rel; }

function isSafeHome(h) {
  return typeof h === "string" && h.length <= 200 && /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(h) &&
    !/(?:^|\/)\.\.?(?:\/|$)/.test(h);
}

// A path the plan may hand to an app: absolute, printable ASCII, no quote or backslash, no dot segments.
function isSafeRealPath(p) {
  return typeof p === "string" && p.length > 0 && p.length <= 600 && p.charAt(0) === "/" && /^[\x20-\x7E]+$/.test(p) &&
    p.indexOf('"') < 0 && p.indexOf("\\") < 0 && !/(?:^|\/)\.\.?(?:\/|$)/.test(p) && p.indexOf("//") < 0;
}

// Checks the output of `realpath -e` against the home folder. Returns {ok, real, rel} or {ok:false, code}.
function checkRealFolder(home, out) {
  if (!isSafeHome(home)) return { ok: false, code: "outside" };
  var line = String(out === undefined || out === null ? "" : out);
  if (line.length > 4096 || /[\r\n\x00]/.test(line)) return { ok: false, code: "outside" };
  var rel;
  if (line === home) {
    rel = "";
  } else if (line.indexOf(home + "/") === 0) {
    rel = line.slice(home.length + 1);
  } else {
    return { ok: false, code: "outside" };
  }
  if (!isSafeRealPath(line)) return { ok: false, code: "outside" };
  if (rel !== "") {
    var parts = rel.split("/");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "" || parts[i].charAt(0) === ".") return { ok: false, code: "outside" };
    }
  }
  return { ok: true, real: line, rel: rel };
}

function lastLine(text) {
  var lines = String(text === undefined || text === null ? "" : text).split("\n");
  for (var i = lines.length - 1; i >= 0; i--) {
    var l = lines[i].replace(/\r$/, "");
    if (l !== "") return l;
  }
  return "";
}

// ---------------------------------------------------------------- Lua templates (spec 5.3)
// Lua is only ever built here, from a frozen table, with typed holes. Nothing is escaped, because nothing needs escaping.
var PX_OK = deepFreeze([0, 100, 200, 300, 600, 1200]);
var HOLE_TYPES = deepFreeze({
  ws: {
    pat: "(?:10|[1-9])",
    enc: function (v) { return (Number.isInteger(v) && v >= 1 && v <= 10) ? String(v) : null; }
  },
  dir: {
    pat: "[lrud]",
    enc: function (v) { return (typeof v === "string" && v.length === 1 && "lrud".indexOf(v) >= 0) ? v : null; }
  },
  bool: {
    pat: "(?:true|false)",
    enc: function (v) { return v === true ? "true" : (v === false ? "false" : null); }
  },
  addr: {
    pat: "0x[0-9a-f]{1,16}",
    enc: function (v) { return (typeof v === "string" && /^0x[0-9a-f]{1,16}$/.test(v)) ? v : null; }
  },
  px: {
    pat: "-?(?:0|100|200|300|600|1200)",
    enc: function (v) { return (Number.isInteger(v) && PX_OK.indexOf(Math.abs(v)) >= 0) ? String(v) : null; }
  }
});

var LUA_TEMPLATES = deepFreeze({
  focus_ws: { text: 'hl.dsp.focus({ workspace = "<ws>" })', holes: { ws: "ws" } },
  focus_window: { text: 'hl.dsp.focus({ window = "address:<addr>" })', holes: { addr: "addr" } },
  focus_dir: { text: 'hl.dsp.focus({ direction = "<dir>" })', holes: { dir: "dir" } },
  move_ws: {
    text: 'hl.dsp.window.move({ workspace = "<ws>", follow = <follow>, window = "address:<addr>" })',
    holes: { ws: "ws", follow: "bool", addr: "addr" }
  },
  move_scratch: {
    text: 'hl.dsp.window.move({ workspace = "special:scratchpad", follow = false, window = "address:<addr>" })',
    holes: { addr: "addr" }
  },
  swap_dir: { text: 'hl.dsp.window.swap({ direction = "<dir>" })', holes: { dir: "dir" } },
  resize: {
    text: 'hl.dsp.window.resize({ x = <x>, y = <y>, relative = true, window = "address:<addr>" })',
    holes: { x: "px", y: "px", addr: "addr" }
  },
  float: { text: 'hl.dsp.window.float({ action = "toggle", window = "address:<addr>" })', holes: { addr: "addr" } },
  fullscreen: { text: 'hl.dsp.window.fullscreen({ mode = "fullscreen", window = "address:<addr>" })', holes: { addr: "addr" } },
  maximized: { text: 'hl.dsp.window.fullscreen({ mode = "maximized", window = "address:<addr>" })', holes: { addr: "addr" } },
  pin: { text: 'hl.dsp.window.pin({ window = "address:<addr>" })', holes: { addr: "addr" } },
  center: { text: 'hl.dsp.window.center({ window = "address:<addr>" })', holes: { addr: "addr" } },
  close: { text: 'hl.dsp.window.close({ window = "address:<addr>" })', holes: { addr: "addr" } },
  group_toggle: { text: 'hl.dsp.group.toggle({ window = "address:<addr>" })', holes: { addr: "addr" } },
  togglesplit: { text: 'hl.dsp.layout("togglesplit")', holes: {} },
  swapsplit: { text: 'hl.dsp.layout("swapsplit")', holes: {} },
  preselect: { text: 'hl.dsp.layout("preselect <dir>")', holes: { dir: "dir" } },
  toggle_special: { text: 'hl.dsp.workspace.toggle_special("scratchpad")', holes: {} }
});

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }

// Each template gets its own anchored regex, built from its text. The tests check "exactly one template matches".
var LUA_REGEXES = {};
(function buildLuaRegexes() {
  var names = Object.keys(LUA_TEMPLATES);
  for (var i = 0; i < names.length; i++) {
    var t = LUA_TEMPLATES[names[i]];
    var pieces = t.text.split(/(<[a-z]+>)/);
    var src = "^";
    for (var j = 0; j < pieces.length; j++) {
      var m = /^<([a-z]+)>$/.exec(pieces[j]);
      src += m ? HOLE_TYPES[t.holes[m[1]]].pat : escapeRe(pieces[j]);
    }
    LUA_REGEXES[names[i]] = new RegExp(src + "$");
  }
})();

// The last guard on every Lua string (spec 5.3). The pieces are written as a pattern, not as words.
var LUA_FORBID = /e(?:xec|val)|os\.|io\.|load|require|\.\.|\[\[|--|\\|\x27|;|[\r\n]/;
function luaGuard(s) {
  return typeof s === "string" && s.length <= 200 && /^hl\.dsp\.[a-z_.]+\(/.test(s) && !LUA_FORBID.test(s);
}

function lua(name, holes) {
  if (typeof name !== "string" || !hasOwn(LUA_TEMPLATES, name)) throw new Error("lua: unknown template");
  var t = LUA_TEMPLATES[name];
  var want = Object.keys(t.holes);
  var given = isObj(holes) ? Object.keys(holes) : [];
  if (given.length !== want.length) throw new Error("lua: wrong holes");
  var out = t.text;
  for (var i = 0; i < want.length; i++) {
    if (!hasOwn(holes, want[i])) throw new Error("lua: missing hole");
    var enc = HOLE_TYPES[t.holes[want[i]]].enc(holes[want[i]]);
    if (enc === null) throw new Error("lua: bad hole");
    out = out.replace("<" + want[i] + ">", enc);
  }
  if (!LUA_REGEXES[name].test(out) || !luaGuard(out)) throw new Error("lua: bad result");
  return out;
}

// ---------------------------------------------------------------- steps (spec 5.1)
var DIR_NAMES = ["left", "right", "up", "down"];
var DIR_CODE = { left: "l", right: "r", up: "u", down: "d" };
var DIR_PHRASE = { left: "on the left", right: "on the right", up: "above", down: "below" };
var PLACE_PHRASE = { left: "to the left of the current window", right: "to the right of the current window", up: "above the current window", down: "below the current window" };
var RESIZE_PX = { small: 100, medium: 200, large: 300, xlarge: 600, huge: 1200 };
var AMOUNT_PHRASE = { small: "a small amount", medium: "a medium amount", large: "a large amount", xlarge: "a very large amount", huge: "a huge amount" };

var WHAT_WINDOW = ["float", "fullscreen", "full_width", "pop_out", "toggle_split", "swap_split", "group", "pin", "center", "transparency", "to_scratchpad", "close"];
// Steps that act on the current layout or run a script on the active window cannot name an app.
var WHAT_WINDOW_APP = ["float", "fullscreen", "full_width", "group", "pin", "center", "to_scratchpad", "close"];
var WHAT_DESKTOP = ["nightlight", "gaps"];
var WHAT_SYSTEM = ["lock", "volume_up", "volume_down", "mute", "brightness_up", "brightness_down", "play_pause", "next_track", "previous_track", "show_time", "show_battery"];

var F = {
  ws: { kind: "int", min: 1, max: 10, desc: "Workspace number, 1 to 10." },
  follow: { kind: "bool", desc: "true to go to that workspace as well. Default false." },
  app: { kind: "enum", values: APP_KEYS, desc: "An app from the list: " + APP_LIST_TEXT + "." },
  direction: { kind: "enum", values: DIR_NAMES, desc: "left, right, up or down." },
  place: { kind: "enum", values: DIR_NAMES, desc: "Where the new window goes, next to the current one: left, right, up or down." },
  folder: { kind: "folder", desc: "A folder inside the home folder, such as ~/projects/site. Up to 4 names; letters, digits, dot, dash and underscore; none starting with a dot." },
  change: { kind: "enum", values: ["wider", "narrower", "taller", "shorter"], desc: "How to change the window size." },
  amount: { kind: "enum", values: ["small", "medium", "large", "xlarge", "huge"], desc: "How much to change it." },
  mode: { kind: "enum", values: ["tiled", "scrolling"], desc: "The layout for the current workspace." },
  whatWindow: { kind: "enum", values: WHAT_WINDOW, desc: "What to do with the window." },
  whatDesktop: { kind: "enum", values: WHAT_DESKTOP, desc: "nightlight or gaps." },
  whatSystem: { kind: "enum", values: WHAT_SYSTEM, desc: "What to do." }
};

var STEP_SPECS = {
  workspace: { fields: { to: F.ws }, required: ["to"], summary: "Go to a workspace." },
  open: { fields: { app: F.app, place: F.place, folder: F.folder }, required: ["app"], summary: "Open an app. Only the terminal, files and vscode can open in a folder." },
  focus: { fields: { app: F.app, direction: F.direction }, required: [], summary: "Focus a window: give app or direction, not both." },
  move: { fields: { to: F.ws, follow: F.follow, app: F.app }, required: ["to"], summary: "Move a window to a workspace. Without app it is the current window." },
  swap: { fields: { direction: F.direction }, required: ["direction"], summary: "Swap the current window with its neighbour." },
  resize: { fields: { change: F.change, amount: F.amount, app: F.app }, required: ["change", "amount"], summary: "Change a window size." },
  window: { fields: { what: F.whatWindow, app: F.app }, required: ["what"], summary: "Do something with a window. app is allowed for float, fullscreen, full_width, group, pin, center, to_scratchpad and close. close needs one window to be known: name its app, or leave app out for the current window." },
  layout: { fields: { mode: F.mode }, required: ["mode"], summary: "Set the layout of the current workspace." },
  scratchpad: { fields: {}, required: [], summary: "Show or hide the scratchpad." },
  desktop: { fields: { what: F.whatDesktop }, required: ["what"], summary: "Toggle the night light or the gaps between windows." },
  system: { fields: { what: F.whatSystem }, required: ["what"], summary: "Lock the screen, change volume or brightness, control music, or show the time or battery in a notification." }
};
var KIND_LIST = Object.keys(STEP_SPECS).join(", ");

function checkField(name, f, v, n) {
  if (f.kind === "int") {
    if (typeof v !== "number" || !Number.isInteger(v) || v < f.min || v > f.max) {
      return sm(n, '"' + name + '" must be a whole number from ' + f.min + " to " + f.max + ".");
    }
  } else if (f.kind === "bool") {
    if (typeof v !== "boolean") return sm(n, '"' + name + '" must be true or false.');
  } else if (f.kind === "enum") {
    if (typeof v !== "string" || f.values.indexOf(v) < 0) {
      if (f === F.app) return sm(n, "that app is not on Omacommand's list. The list: " + APP_LIST_TEXT + ".");
      return sm(n, '"' + name + '" must be one of: ' + f.values.join(", ") + ".");
    }
  } else if (f.kind === "folder") {
    if (typeof v !== "string" || !FOLDER_RE.test(v)) {
      return sm(n, '"folder" must be a folder inside the home folder, such as ~/projects/site (up to 4 names, with no spaces and none starting with a dot).');
    }
  }
  return null;
}

function validateStep(raw, n) {
  if (!isObj(raw)) return fail(sm(n, "this step must be an object."));
  if (!hasOwn(raw, "do") || typeof raw["do"] !== "string" || !hasOwn(STEP_SPECS, raw["do"])) {
    return fail(sm(n, "that kind of step is not on Omacommand's list. The kinds: " + KIND_LIST + "."));
  }
  var kind = raw["do"];
  var spec = STEP_SPECS[kind];
  var keys = Object.keys(raw);
  var i;
  for (i = 0; i < keys.length; i++) {
    if (keys[i] !== "do" && !hasOwn(spec.fields, keys[i])) return fail(sm(n, "that step has a field Omacommand does not know."));
  }
  for (i = 0; i < spec.required.length; i++) {
    if (!hasOwn(raw, spec.required[i])) return fail(sm(n, '"' + spec.required[i] + '" is missing.'));
  }
  var out = { "do": kind };
  var names = Object.keys(spec.fields);
  for (i = 0; i < names.length; i++) {
    if (!hasOwn(raw, names[i])) continue;
    var err = checkField(names[i], spec.fields[names[i]], raw[names[i]], n);
    if (err) return fail(err);
    out[names[i]] = raw[names[i]];
  }
  if (kind === "open" && hasOwn(out, "folder") && !APPS[out.app].folder) {
    return fail(sm(n, APPS[out.app].name + " cannot open in a folder."));
  }
  if (kind === "focus" && hasOwn(out, "app") === hasOwn(out, "direction")) {
    return fail(sm(n, 'a focus step needs either "app" or "direction", not both.'));
  }
  if (kind === "window" && hasOwn(out, "app") && WHAT_WINDOW_APP.indexOf(out.what) < 0) {
    return fail(sm(n, '"app" cannot be used with this kind of window step.'));
  }
  return { ok: true, step: out };
}

// The plan the box shows and the run uses: validated, copied field by field, frozen (spec 3.6, 5.7).
function validatePlan(plan) {
  if (!isObj(plan)) return fail(MSG.planShape);
  var keys = Object.keys(plan);
  if (keys.length !== 1 || keys[0] !== "steps") return fail(keys.indexOf("steps") >= 0 ? MSG.planField : MSG.planShape);
  var steps = plan.steps;
  if (!Array.isArray(steps)) return fail(MSG.planShape);
  if (steps.length === 0) return fail(MSG.noSteps);
  if (steps.length > LIMITS.maxSteps) return fail(MSG.tooManySteps);
  var out = [];
  for (var i = 0; i < steps.length; i++) {
    var r = validateStep(steps[i], i + 1);
    if (!r.ok) return r;
    out.push(r.step);
  }
  return { ok: true, plan: deepFreeze({ steps: out }) };
}

// ---------------------------------------------------------------- words (spec 3.2)
function targetWords(step) {
  return hasOwn(step, "app") ? "the " + APPS[step.app].name + " window" : "the current window";
}

function workspaceWords(ws, name) {
  if (Number.isInteger(ws) && ws >= 1 && ws <= 10) return "on workspace " + ws;
  return name === "special:scratchpad" ? "on the scratchpad" : "on another workspace";
}

// ctx.folder = {shown, link} for an open step with a folder; ctx.close = {app, workspace, name} for a close step.
function stepWords(step, ctx) {
  ctx = ctx || {};
  var s;
  switch (step["do"]) {
    case "workspace":
      return "Go to workspace " + step.to;
    case "open":
      s = "Open " + APPS[step.app].name;
      if (hasOwn(step, "folder")) {
        var f = ctx.folder || { shown: displayRel(folderRel(step.folder)), link: null };
        s += ' in "' + f.shown + '"';
        if (f.link) s += ' (a link to "' + f.link + '")';
      }
      if (hasOwn(step, "place")) s += " " + PLACE_PHRASE[step.place];
      return s;
    case "focus":
      return hasOwn(step, "app") ? "Focus the " + APPS[step.app].name + " window" : "Focus the window " + DIR_PHRASE[step.direction];
    case "move":
      return "Move " + targetWords(step) + " to workspace " + step.to + (step.follow === true ? " and go there" : "");
    case "swap":
      return "Swap the current window with the one " + DIR_PHRASE[step.direction];
    case "resize":
      return "Make " + targetWords(step) + " " + step.change + " by " + AMOUNT_PHRASE[step.amount];
    case "window":
      return windowWords(step, ctx);
    case "layout":
      return "Switch this workspace to the " + step.mode + " layout";
    case "scratchpad":
      return "Show or hide the scratchpad";
    case "desktop":
      return step.what === "nightlight" ? "Toggle the night light" : "Toggle the gaps between windows";
    case "system":
      return SYSTEM_WORDS[step.what];
  }
  throw new Error("stepWords: unknown step");
}

function windowWords(step, ctx) {
  var t = targetWords(step);
  switch (step.what) {
    case "float": return "Toggle floating for " + t;
    case "fullscreen": return "Toggle full screen for " + t;
    case "full_width": return "Toggle full width for " + t;
    case "pop_out": return "Pop the current window out of the tiling";
    case "toggle_split": return "Toggle the split direction of the current window";
    case "swap_split": return "Swap the two sides of the current split";
    case "group": return "Toggle tab grouping for " + t;
    case "pin": return "Toggle pinning for " + t;
    case "center": return "Center " + t;
    case "transparency": return "Toggle transparency for the current window";
    case "to_scratchpad": return "Send " + t + " to the scratchpad";
    case "close":
      var c = ctx.close || { app: hasOwn(step, "app") ? step.app : "other", workspace: 0, workspaceName: "" };
      var who = (c.app !== "other" && hasOwn(APPS, c.app)) ? "the " + APPS[c.app].name + " window" : "a window of an app that is not on Omacommand's list,";
      return "Close " + who + " " + workspaceWords(c.workspace, c.workspaceName) + " (unsaved work in it may be lost)";
  }
  throw new Error("windowWords: unknown");
}

var SYSTEM_WORDS = {
  lock: "Lock the screen",
  volume_up: "Turn the volume up",
  volume_down: "Turn the volume down",
  mute: "Mute or unmute the sound",
  brightness_up: "Turn the screen brightness up",
  brightness_down: "Turn the screen brightness down",
  play_pause: "Play or pause the music",
  next_track: "Skip to the next track",
  previous_track: "Go back to the previous track",
  show_time: "Show the time in a notification",
  show_battery: "Show the battery level in a notification"
};

// Patterns the box lines must match (without the "N. " number). Used by the tests as the "template list".
var WORD_PATTERNS = [
  /^Go to workspace (?:10|[1-9])$/,
  /^Open (?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop)(?: in "~(?:\/[\x20-\x7E]*)?"(?: \(a link to "~(?:\/[\x20-\x7E]*)?"\))?)?(?: (?:to the left of|to the right of|above|below) the current window)?$/,
  /^Focus the (?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop) window$/,
  /^Focus the window (?:on the left|on the right|above|below)$/,
  /^Move the (?:current|(?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop)) window to workspace (?:10|[1-9])(?: and go there)?$/,
  /^Swap the current window with the one (?:on the left|on the right|above|below)$/,
  /^Make the (?:current|(?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop)) window (?:wider|narrower|taller|shorter) by a(?: small| medium| large| very large| huge) amount$/,
  /^Toggle (?:floating|full screen|full width|tab grouping|pinning) for the (?:current|(?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop)) window$/,
  /^Center the (?:current|(?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop)) window$/,
  /^Send the (?:current|(?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop)) window to the scratchpad$/,
  /^Pop the current window out of the tiling$/,
  /^Toggle the split direction of the current window$/,
  /^Swap the two sides of the current split$/,
  /^Toggle transparency for the current window$/,
  /^Close (?:the (?:Terminal|Browser|Files|VS Code|Obsidian|Spotify|btop) window|a window of an app that is not on Omacommand's list,) (?:on workspace (?:10|[1-9])|on the scratchpad|on another workspace) \(unsaved work in it may be lost\)$/,
  /^Switch this workspace to the (?:tiled|scrolling) layout$/,
  /^Show or hide the scratchpad$/,
  /^Toggle the (?:night light|gaps between windows)$/,
  /^(?:Lock the screen|Turn the volume (?:up|down)|Mute or unmute the sound|Turn the screen brightness (?:up|down)|Play or pause the music|Skip to the next track|Go back to the previous track|Show the (?:time|battery level) in a notification)$/
];

var BOX_TITLE = "An AI agent on this computer wants to:";
var BOX_FOOTER = "Nothing runs until you click Allow. Esc or Deny means no.";
var BOX_CLOSE_NOTE = "This request closes a window.";

// The box text: numbered lines made only from stepWords (spec 3.2). A plan whose text breaks a cap is refused, never cut.
// prep.folders[i] and prep.closes[i] hold what was resolved before the box.
function buildBoxLines(plan, prep) {
  prep = prep || {};
  var lines = [];
  var total = 0;
  var hasClose = false;
  for (var i = 0; i < plan.steps.length; i++) {
    var step = plan.steps[i];
    var ctx = { folder: prep.folders ? prep.folders[i] : undefined, close: prep.closes ? prep.closes[i] : undefined };
    var text = (i + 1) + ". " + stepWords(step, ctx);
    if (text.length > LIMITS.maxLineChars || asciiLine(text, 0) !== text) return fail(MSG.textTooLong);
    total += text.length;
    var isClose = step["do"] === "window" && step.what === "close";
    if (isClose) hasClose = true;
    lines.push({ text: text, urgent: isClose, mono: hasOwn(step, "folder") });
  }
  if (total > LIMITS.maxTotalChars) return fail(MSG.textTooLong);
  return { ok: true, lines: lines, hasClose: hasClose };
}

// One word per step for the log (spec 10.1): kinds and catalogue words only, never a folder name.
function logWord(step) {
  var k = step["do"];
  if (k === "open") return "open:" + step.app + (hasOwn(step, "folder") ? "(folder)" : "");
  if (k === "window") return "window:" + step.what;
  if (k === "desktop" || k === "system") return k + ":" + step.what;
  return k;
}
function planSummary(plan) {
  var w = [];
  for (var i = 0; i < plan.steps.length; i++) w.push(logWord(plan.steps[i]));
  return w.join(",");
}

// ---------------------------------------------------------------- planning commands (spec 5.2, 5.3)
// A plan step becomes a list of ops. Nothing runs here. A "lua" op with `win` gets its window address when it runs.
function planOps(step, env) {
  env = env || {};
  var win = hasOwn(step, "app") ? { app: step.app } : { app: null };
  switch (step["do"]) {
    case "workspace":
      return [{ t: "lua", name: "focus_ws", holes: { ws: step.to } }];
    case "open":
      // A step with a folder never starts without the resolved folder: that would silently drop what the person approved.
      if (hasOwn(step, "folder") && typeof env.folderReal !== "string") throw new Error("planOps: folder not resolved");
      return [{
        t: "open", app: step.app, reuse: APPS[step.app].reuse && !hasOwn(step, "folder"),
        place: hasOwn(step, "place") ? DIR_CODE[step.place] : null,
        argv: appArgv(step.app, hasOwn(step, "folder") ? env.folderReal : undefined)
      }];
    case "focus":
      if (hasOwn(step, "app")) return [{ t: "lua", name: "focus_window", holes: {}, win: win }];
      return [{ t: "lua", name: "focus_dir", holes: { dir: DIR_CODE[step.direction] } }];
    case "move":
      return [{ t: "lua", name: "move_ws", holes: { ws: step.to, follow: step.follow === true }, win: win }];
    case "swap":
      return [{ t: "lua", name: "swap_dir", holes: { dir: DIR_CODE[step.direction] } }];
    case "resize":
      return [{ t: "lua", name: "resize", holes: resizeHoles(step.change, step.amount), win: win }];
    case "window":
      return windowOps(step, win);
    case "layout":
      return [{ t: "layout", mode: step.mode, argv: LAYOUT_CMD.slice() }];
    case "scratchpad":
      return [{ t: "lua", name: "toggle_special", holes: {} }];
    case "desktop":
      return [{ t: "exec", argv: DESKTOP_CMDS[step.what].slice() }];
    case "system":
      // "run" waits for the exit code and reports a failure; "exec" only starts the command (review C4).
      return [{ t: hasOwn(SYSTEM_TRACKED, step.what) ? "run" : "exec", argv: SYSTEM_CMDS[step.what].slice() }];
  }
  throw new Error("planOps: unknown step");
}

function resizeHoles(change, amount) {
  var px = RESIZE_PX[amount];
  var h = { x: 0, y: 0 };
  if (change === "wider") h.x = px;
  else if (change === "narrower") h.x = -px;
  else if (change === "taller") h.y = px;
  else h.y = -px;
  return h;
}

var WINDOW_LUA = { float: "float", fullscreen: "fullscreen", full_width: "maximized", pin: "pin", center: "center", group: "group_toggle", to_scratchpad: "move_scratch" };

function windowOps(step, win) {
  var w = step.what;
  if (w === "close") return [{ t: "close", app: hasOwn(step, "app") ? step.app : null }];
  if (hasOwn(WINDOW_LUA, w)) return [{ t: "lua", name: WINDOW_LUA[w], holes: {}, win: win }];
  if (w === "toggle_split") return [{ t: "lua", name: "togglesplit", holes: {} }];
  if (w === "swap_split") return [{ t: "lua", name: "swapsplit", holes: {} }];
  return [{ t: "exec", argv: WINDOW_CMDS[w].slice() }];
}

// Builds the Lua for a "lua" op. addr is the resolved window ("0x...") when the op has a window.
function luaFor(op, addr) {
  var h = {};
  var ks = Object.keys(op.holes);
  for (var i = 0; i < ks.length; i++) h[ks[i]] = op.holes[ks[i]];
  if (op.win) h.addr = addr;
  return lua(op.name, h);
}

function preselectLua(dirCode) { return lua("preselect", { dir: dirCode }); }

// ---------------------------------------------------------------- addresses and windows (spec 5.5, 5.6)
function normAddr(a) {
  if (typeof a !== "string") return "";
  var s = a.toLowerCase();
  if (!/^(?:0x)?[0-9a-f]{1,16}$/.test(s)) return "";
  return s.indexOf("0x") === 0 ? s : "0x" + s;
}

function findWindow(windows, addr) {
  for (var i = 0; i < windows.length; i++) if (windows[i].address === addr) return windows[i];
  return null;
}

function usable(w) { return w && w.mapped !== false && normAddr(w.address) !== ""; }

function focusRank(w) { return Number.isInteger(w.focusHistoryID) ? w.focusHistoryID : 1000000; }

// Steps that do not close pick their window when they run: the one this plan opened for that app, else the most
// recently focused window of that app. With no app it is the active window. An app that is not open gives null.
function resolveWindow(app, windows, opened, activeAddress) {
  if (app) {
    if (opened && hasOwn(opened, app)) {
      var w0 = findWindow(windows, opened[app]);
      if (usable(w0) && appForClass(w0.cls) === app) return w0.address;
    }
    var best = null;
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      if (!usable(w) || appForClass(w.cls) !== app) continue;
      if (best === null || focusRank(w) < focusRank(best)) best = w;
    }
    return best ? best.address : null;
  }
  if (activeAddress) {
    var a = findWindow(windows, activeAddress);
    if (usable(a)) return a.address;
  }
  return null;
}

// A window is bound only if it can be told apart from others: a real pid and a stable id. A window read from an
// empty record (pid 0, no stable id, no class) would otherwise pass the check against any other empty one (review C11).
function bindable(w) {
  return !!w && Number.isInteger(w.pid) && w.pid > 0 && typeof w.stableId === "string" && w.stableId !== "";
}

function bindingOf(w) {
  return {
    address: w.address, stableId: w.stableId, pid: w.pid, cls: w.cls, initialClass: w.initialClass,
    workspace: w.workspaceId, workspaceName: w.workspaceName || "", app: appForClass(w.cls)
  };
}

// Close picks exactly one window when the box is built (spec 5.5).
function findCloseTarget(step, n, snap) {
  var all = (snap && snap.windows) || [];
  var wins = [];
  for (var i = 0; i < all.length && i < LIMITS.maxClients; i++) if (usable(all[i])) wins.push(all[i]);
  if (hasOwn(step, "app")) {
    var m = [];
    for (var j = 0; j < wins.length; j++) if (appForClass(wins[j].cls) === step.app) m.push(wins[j]);
    var name = APPS[step.app].name;
    if (m.length === 0) return fail(sm(n, name + " is not open."));
    if (m.length > 1) {
      return fail(sm(n, "There are " + m.length + " " + name + " windows. Omacommand closes a window only when it knows which: ask the person to focus it, then propose closing the current window."));
    }
    if (!bindable(m[0])) return fail(sm(n, MSG.cannotTell));
    return { ok: true, binding: bindingOf(m[0]) };
  }
  var a = snap && snap.activeAddress ? findWindow(wins, snap.activeAddress) : null;
  if (!a) return fail(sm(n, "there is no current window to close."));
  if (!bindable(a)) return fail(sm(n, MSG.cannotTell));
  return { ok: true, binding: bindingOf(a) };
}

// Just before the close is dispatched (spec 5.5). `closed` is the set of addresses that had a closewindow event.
function verifyBinding(b, windows, closed) {
  if (closed && hasOwn(closed, b.address)) return fail(MSG.gone);
  var w = findWindow(windows, b.address);
  if (!w || w.mapped === false) return fail(MSG.gone);
  if (w.pid !== b.pid || w.cls !== b.cls || w.initialClass !== b.initialClass || w.stableId !== b.stableId) return fail(MSG.changed);
  return { ok: true };
}

// ---------------------------------------------------------------- the desktop state for the agent (spec 7.4)
function layoutWord(raw) {
  if (raw === "scrolling") return "scrolling";
  if (raw === "dwindle") return "tiled";
  return "other";
}

function buildState(snap) {
  var layouts = {};
  var wsl = (snap && snap.workspaces) || [];
  for (var i = 0; i < wsl.length; i++) {
    if (Number.isInteger(wsl[i].id)) layouts[wsl[i].id] = layoutWord(wsl[i].layout);
  }
  var all = ((snap && snap.windows) || []).slice(0, LIMITS.maxClients);
  var wins = [];
  for (var k = 0; k < all.length; k++) if (usable(all[k])) wins.push(all[k]);
  wins.sort(function (a, b) { return focusRank(a) - focusRank(b); });
  var byWs = {};
  var scratch = 0;
  var total = 0;
  for (var j = 0; j < wins.length; j++) {
    var w = wins[j];
    if (w.workspaceName === "special:scratchpad") { scratch++; continue; }
    var id = w.workspaceId;
    if (!Number.isInteger(id) || id < 1 || id > 10) continue;
    if (total >= LIMITS.maxWindowsTotal) break;
    if (!hasOwn(byWs, id)) byWs[id] = [];
    if (byWs[id].length >= LIMITS.maxWindowsPerWorkspace) continue;
    byWs[id].push({ app: appForClass(w.cls), focused: w.focused === true, floating: w.floating === true, fullscreen: w.fullscreen === true });
    total++;
  }
  var active = snap && Number.isInteger(snap.activeWorkspace) && snap.activeWorkspace >= 1 && snap.activeWorkspace <= 10 ? snap.activeWorkspace : null;
  var out = [];
  for (var n = 1; n <= 10; n++) {
    if (hasOwn(byWs, n) || n === active) {
      out.push({ id: n, layout: hasOwn(layouts, n) ? layouts[n] : "other", windows: hasOwn(byWs, n) ? byWs[n] : [] });
    }
  }
  var state = { v: 1, active_workspace: active, workspaces: out, scratchpad: scratch };
  // Every answer is at most 8 KiB (spec 6.2). The oldest-focused windows are dropped first if 128 of them would not fit.
  for (var guardN = 0; guardN < LIMITS.maxWindowsTotal && JSON.stringify(state).length > 8000; guardN++) {
    var dropped = false;
    for (var q = out.length - 1; q >= 0 && !dropped; q--) {
      if (out[q].windows.length > 0) {
        out[q].windows.pop();
        dropped = true;
      }
    }
    state.truncated = true;
    if (!dropped) break;
  }
  return state;
}

// ---------------------------------------------------------------- the request (spec 6.3)
// True when the text nests deeper than the limit. A scan outside strings, done before JSON.parse ever sees it.
function nestingTooDeep(text, max) {
  var limit = max === undefined ? LIMITS.maxNesting : max;
  var depth = 0;
  var inStr = false;
  var esc = false;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
    } else if (c === 34) {
      inStr = true;
    } else if (c === 91 || c === 123) {
      depth++;
      if (depth > limit) return true;
    } else if (c === 93 || c === 125) {
      depth--;
    }
  }
  return false;
}

var ID_RE = /^[0-9a-f]{32}$/;

// Exact keys and types of the request envelope. The plan itself is checked by validatePlan.
function checkEnvelope(obj) {
  if (!isObj(obj)) return fail(MSG.badRequest);
  var keys = Object.keys(obj).sort();
  if (keys.join(",") !== "client,id,plan,sent_at,v") return fail(MSG.badRequest);
  if (obj.v !== 1 || typeof obj.id !== "string" || !ID_RE.test(obj.id)) return fail(MSG.badRequest);
  if (typeof obj.sent_at !== "number" || !Number.isInteger(obj.sent_at) || obj.sent_at <= 0) return fail(MSG.badRequest);
  if (typeof obj.client !== "string" || obj.client.length > LIMITS.maxClientChars) return fail(MSG.badRequest);
  if (!isObj(obj.plan)) return fail(MSG.badRequest);
  return { ok: true, id: obj.id, sentAt: obj.sent_at, client: obj.client, plan: obj.plan };
}

function checkSentAt(sentAt, now) {
  return Math.abs(now - sentAt) <= LIMITS.maxSkewMs;
}

// The agent's self-reported name goes to the log only, and only if it is plain (spec 4).
function logClient(name) {
  return /^[A-Za-z0-9 ._-]{1,32}$/.test(name) ? 'client="' + name + '" (self-reported)' : "client=unknown";
}

// ---------------------------------------------------------------- welcome text helpers (spec 3.9)
// The plugin's own folder as an absolute path that is safe to paste into a command, or "" if it is not.
function safeServerPath(fileUrl, home) {
  var p = String(fileUrl === undefined || fileUrl === null ? "" : fileUrl);
  if (p.indexOf("file://") === 0) p = p.slice(7);
  try { p = decodeURIComponent(p); } catch (e) { p = ""; }
  var ok = /^\/[A-Za-z0-9._@+\/-]+\/mcp\/server\.rb$/.test(p) && p.indexOf("//") < 0 && !/(?:^|\/)\.\.(?:\/|$)/.test(p);
  if (ok) return p;
  if (isSafeHome(home)) return home + "/.config/omarchy/plugins/" + PLUGIN_ID + "/mcp/server.rb";
  return "";
}

// ---------------------------------------------------------------- exported object (QML and the tests use this)
var VocabApi = {
  PLUGIN_ID: PLUGIN_ID, VERSION: VERSION, LIMITS: LIMITS, MSG: MSG, paused: paused,
  INTERNAL_PROPOSE: INTERNAL_PROPOSE, INTERNAL_PLAIN: INTERNAL_PLAIN, NOT_READY: NOT_READY,
  cleanLine: cleanLine, asciiLine: asciiLine,
  APP_KEYS: APP_KEYS, APPS: APPS, appForClass: appForClass, appArgv: appArgv,
  DESKTOP_CMDS: DESKTOP_CMDS, WINDOW_CMDS: WINDOW_CMDS, LAYOUT_CMD: LAYOUT_CMD, SYSTEM_CMDS: SYSTEM_CMDS,
  SYSTEM_TRACKED: SYSTEM_TRACKED, SPOTIFY_CHECK: SPOTIFY_CHECK,
  FOLDER_RE: FOLDER_RE, folderRel: folderRel, displayRel: displayRel, isSafeHome: isSafeHome, isSafeRealPath: isSafeRealPath,
  checkRealFolder: checkRealFolder, lastLine: lastLine,
  LUA_TEMPLATES: LUA_TEMPLATES, LUA_REGEXES: LUA_REGEXES, HOLE_TYPES: HOLE_TYPES, luaGuard: luaGuard, lua: lua,
  STEP_SPECS: STEP_SPECS, FIELDS: F, KIND_LIST: KIND_LIST, APP_LIST_TEXT: APP_LIST_TEXT,
  validateStep: validateStep, validatePlan: validatePlan,
  stepWords: stepWords, WORD_PATTERNS: WORD_PATTERNS,
  BOX_TITLE: BOX_TITLE, BOX_FOOTER: BOX_FOOTER, BOX_CLOSE_NOTE: BOX_CLOSE_NOTE,
  buildBoxLines: buildBoxLines, logWord: logWord, planSummary: planSummary,
  planOps: planOps, luaFor: luaFor, preselectLua: preselectLua,
  normAddr: normAddr, findWindow: findWindow, resolveWindow: resolveWindow, bindingOf: bindingOf,
  findCloseTarget: findCloseTarget, verifyBinding: verifyBinding, bindable: bindable,
  layoutWord: layoutWord, buildState: buildState,
  nestingTooDeep: nestingTooDeep, checkEnvelope: checkEnvelope, checkSentAt: checkSentAt, ID_RE: ID_RE, logClient: logClient,
  safeServerPath: safeServerPath,
  deepFreeze: deepFreeze, hasOwn: hasOwn, isObj: isObj
};
