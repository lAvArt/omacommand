// Omacommand box model: the rules of the Allow box and of one request, as plain functions of events and a clock (spec 3, 6).
//
// Plain script, like vocab.js: QML imports it, the tests load the same bytes with vm. It holds no Quickshell objects.
// The QML service gives it `ports` (start a process, run a detached command, read Hyprland, show the box, write the log).
// Time is always passed in, so the tests drive everything with a fake clock. Use Model, never the top-level names:
//   var desk = createDesk(VocabApi, ports)

var BOX_DELAY_MS = 1000; // Allow is clickable this long after the box is fully drawn (spec 3.3)
var BOX_TIMEOUT_MS = 45000; // auto-deny, counted from the first full draw (spec 3.4)
var BOX_UNDRAWN_MS = 10000; // a box that never got drawn is given up on
var BOX_STALL_MS = 5000; // the clock jumped or the shell stalled: the delay starts again
var BOX_COUNTDOWN_MS = 10000; // the countdown shows in the last 10 seconds
var RUN_START_DELAY_MS = 150; // focus is back on the old window by then (spec 3.4)
var SETTLE_MS = 700; // two toggles in a row race, so each started command gets a pause
var REFRESH_WAIT_MS = 350; // let Hyprland's answer to a refresh arrive before reading it
var OPEN_WAIT_MS = 30000; // an app may take this long to show its window
var EVENT_REFRESH_MS = 250; // refresh debounce after window events (spec 5.6)
var PROC_KILL_GRACE_MS = 1000;
var RUN_TIMEOUT_MS = 6000; // a short system command (volume, brightness, music) may take this long before it is stopped
var MOTION_EPS = 0.5; // pixels: a smaller change of the pointer position is rounding noise, not a pointer that moved

var HINT_CLICK = "Click Allow with the mouse.";
var HINT_WAIT = "Allow is not ready yet. Wait a moment.";
var HINT_MOVE = "Move the pointer over Allow, then click.";

// ---------------------------------------------------------------- rate limits (spec 3.5)
function createGuard(V) {
  var lastEnd = -1;
  var coolUntil = 0;
  var pauseUntil = 0;
  var invalidUntil = 0;
  var denies = [];
  var invalids = [];
  var lastState = -1;

  function prune(list, now, span) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (now - list[i] < span) out.push(list[i]);
    return out;
  }

  return {
    // null when a proposal may go on, else {word, message}
    check: function (now) {
      if (now < pauseUntil) return { word: "paused", message: V.paused(Math.ceil((pauseUntil - now) / 60000)) };
      if (now < invalidUntil) return { word: "invalid-pause", message: V.MSG.invalidPause };
      if (now < coolUntil) return { word: "cooldown", message: V.MSG.rate };
      if (lastEnd >= 0 && now - lastEnd < 2000) return { word: "spacing", message: V.MSG.rate };
      return null;
    },
    // A proposal ended. Returns "paused-10m", "paused-1h" or "".
    ended: function (now, outcome) {
      lastEnd = now;
      if (outcome === "deny" || outcome === "timeout" || outcome === "denypause") {
        coolUntil = now + 10000;
        denies = prune(denies, now, 600000);
        denies.push(now);
        if (outcome === "denypause") {
          pauseUntil = Math.max(pauseUntil, now + 3600000);
          denies = [];
          return "paused-1h";
        }
        if (denies.length >= 3) {
          pauseUntil = Math.max(pauseUntil, now + 600000);
          denies = [];
          return "paused-10m";
        }
      }
      return "";
    },
    // A proposal that never reached a box.
    invalid: function (now) {
      invalids = prune(invalids, now, 60000);
      invalids.push(now);
      if (invalids.length > 20) {
        invalidUntil = now + 60000;
        invalids = [];
      }
    },
    // true when state() may answer
    allowState: function (now) {
      if (lastState >= 0 && now - lastState < 1000) return false;
      lastState = now;
      return true;
    }
  };
}

// ---------------------------------------------------------------- ids seen this session (spec 6.3)
function createSeenIds(max) {
  var set = Object.create(null);
  var queue = [];
  return {
    has: function (id) { return set[id] === true; },
    add: function (id) {
      if (set[id] === true) return;
      set[id] = true;
      queue.push(id);
      if (queue.length > max) delete set[queue.shift()];
    },
    size: function () { return queue.length; }
  };
}

// ---------------------------------------------------------------- request records (spec 6.5)
function createRecords(V) {
  var map = Object.create(null);
  var order = [];

  function drop(id) {
    delete map[id];
    var k = order.indexOf(id);
    if (k >= 0) order.splice(k, 1);
  }

  function get(id, now) {
    if (typeof id !== "string" || !V.ID_RE.test(id)) return null;
    var rec = map[id];
    if (!rec) return null;
    if (rec.endedAt >= 0 && now - rec.endedAt > V.LIMITS.recordKeepMs) {
      drop(id);
      return null;
    }
    return rec;
  }

  return {
    create: function (id) {
      map[id] = { id: id, state: "pending", message: V.MSG.waiting, steps: [], endedAt: -1 };
      order.push(id);
      while (order.length > V.LIMITS.maxRecords) delete map[order.shift()];
    },
    update: function (id, patch) {
      var rec = map[id];
      if (!rec) return;
      var ks = Object.keys(patch);
      for (var i = 0; i < ks.length; i++) rec[ks[i]] = patch[ks[i]];
    },
    finish: function (id, state, message, steps, now) {
      var rec = map[id];
      if (!rec) return;
      rec.state = state;
      rec.message = message;
      rec.steps = steps.slice();
      rec.endedAt = now;
    },
    json: function (id, now) {
      var rec = get(id, now);
      if (!rec) {
        return JSON.stringify({ v: 1, id: (typeof id === "string" && V.ID_RE.test(id)) ? id : "", state: "unknown", message: V.MSG.noRecord, steps: [] });
      }
      return JSON.stringify({ v: 1, id: rec.id, state: rec.state, message: rec.message, steps: rec.steps });
    },
    count: function () { return order.length; }
  };
}

// ---------------------------------------------------------------- the Allow box input rules (spec 3.3, 3.4)
function createBoxModel(V) {
  var last = -1;
  var offset = 0;
  var s = fresh();

  function fresh() {
    return {
      open: false, visible: false, sizeOk: false, focused: false, lostFocus: false, epoch: 0, shownAt: -1, drawnAt: -1,
      firstDrawnAt: -1, lastMoveAt: -1, hasPos: false, posX: 0, posY: 0, press: null, decision: null, hint: "", screen: ""
    };
  }

  function restart() {
    s.drawnAt = -1;
    s.epoch++;
    s.press = null;
  }

  // The model's own clock never runs backwards, and a long gap between calls restarts the delay.
  function clock(now) {
    var t = Number(now);
    if (!isFinite(t)) t = last >= 0 ? last : 0;
    t += offset;
    if (last >= 0 && t < last) {
      offset += last - t;
      t = last;
    }
    if (s.open && last >= 0 && t - last > BOX_STALL_MS) restart();
    last = t;
    return t;
  }

  return {
    show: function (now, screenKey) {
      var t = clock(now);
      s = fresh();
      s.open = true;
      s.shownAt = t;
      s.screen = String(screenKey);
    },
    close: function () { s = fresh(); },
    isOpen: function () { return s.open; },
    // The window became visible or hidden. Either way the delay starts again.
    visibleChanged: function (visible, now) {
      clock(now);
      if (!s.open) return;
      s.visible = !!visible;
      if (!s.visible) s.sizeOk = false;
      restart();
    },
    screenChanged: function (key, now) {
      clock(now);
      if (!s.open) return;
      if (String(key) !== s.screen) {
        s.screen = String(key);
        restart();
      }
    },
    // The window size equals the screen size.
    geometry: function (sizeOk, now) {
      clock(now);
      if (!s.open) return;
      if (s.sizeOk !== !!sizeOk) {
        s.sizeOk = !!sizeOk;
        restart();
      }
    },
    // A frame was presented. The first one after visible and sized right is "fully drawn".
    frame: function (now) {
      var t = clock(now);
      if (s.open && s.visible && s.sizeOk && s.drawnAt < 0) {
        s.drawnAt = t;
        if (s.firstDrawnAt < 0) s.firstDrawnAt = t;
      }
    },
    // Keyboard focus came or went (Window.active). A loss restarts the delay, and so does every gain after a loss (spec 3.3:
    // "loses and regains"), so Allow is never ready the moment focus comes back. The FIRST gain does not restart: it comes a
    // few ms after the first frame (pilot: frame at 45 ms, focus at 49 ms), and no second frame is coming for a box that
    // does not change (review C1).
    activeChanged: function (active, now) {
      clock(now);
      if (!s.open) return;
      var a = !!active;
      if (a === s.focused) return;
      s.focused = a;
      if (!a) {
        s.lostFocus = true;
        restart();
      } else if (s.lostFocus) {
        restart();
      }
    },
    // True while the box is visible and has no counted frame: the window is asked for one (spec 3.3, review C1).
    wantsFrame: function () {
      return s.open && s.visible && !s.decision && s.drawnAt < 0;
    },
    // The pointer moved over Allow (the model's own clock). The tests use this one directly.
    pointerMoved: function (now) {
      var t = clock(now);
      if (s.open) s.lastMoveAt = t;
    },
    // The pointer entered Allow or an event arrived, with its GLOBAL position. Only a changed position counts as motion:
    // a layout shift or a synthetic hover under a pointer that sat still reports the same global position (review C2).
    // The first position only sets the reference: a compositor may send the first enter late (after Allow is ready) for a
    // pointer that never moved, so motion is always a later report at another position. A position that is not a finite
    // number never counts.
    pointerAt: function (gx, gy, now) {
      var t = clock(now);
      if (!s.open || typeof gx !== "number" || typeof gy !== "number" || !isFinite(gx) || !isFinite(gy)) return;
      if (!s.hasPos) {
        s.hasPos = true;
        s.posX = gx;
        s.posY = gy;
        return;
      }
      if (Math.abs(gx - s.posX) < MOTION_EPS && Math.abs(gy - s.posY) < MOTION_EPS) return;
      s.posX = gx;
      s.posY = gy;
      s.lastMoveAt = t;
    },
    press: function (kind, now) {
      var t = clock(now);
      if (!s.open || s.decision) return;
      var ready = s.drawnAt >= 0 && t >= s.drawnAt + BOX_DELAY_MS;
      if (!ready) {
        s.hint = HINT_WAIT;
        s.press = null;
        return;
      }
      if (kind !== "touch" && s.lastMoveAt < s.drawnAt + BOX_DELAY_MS) {
        s.hint = HINT_MOVE;
        s.press = null;
        return;
      }
      s.press = { epoch: s.epoch, kind: kind === "touch" ? "touch" : "mouse" };
    },
    release: function (inside, now) {
      var t = clock(now);
      var p = s.press;
      s.press = null;
      if (!s.open || s.decision || !p) return;
      if (p.epoch !== s.epoch || !inside) return;
      if (s.drawnAt < 0 || t < s.drawnAt + BOX_DELAY_MS) return;
      s.decision = "allow";
    },
    // Keys never approve. Esc denies; Enter only shows a hint; auto-repeated keys are ignored.
    key: function (name, isAutoRepeat, now) {
      clock(now);
      if (!s.open || s.decision || isAutoRepeat) return;
      if (name === "escape") s.decision = "deny";
      else if (name === "enter") s.hint = HINT_CLICK;
    },
    deny: function (now) {
      clock(now);
      if (s.open && !s.decision) s.decision = "deny";
    },
    denyPause: function (now) {
      clock(now);
      if (s.open && !s.decision) s.decision = "denypause";
    },
    // The request itself changed under the box (a bound window closed): no.
    abort: function (word) {
      if (s.open && !s.decision) s.decision = word;
    },
    tick: function (now) {
      var t = clock(now);
      if (!s.open || s.decision) return;
      if (s.firstDrawnAt >= 0) {
        if (t - s.firstDrawnAt >= BOX_TIMEOUT_MS) s.decision = "timeout";
      } else if (s.shownAt >= 0 && t - s.shownAt >= BOX_UNDRAWN_MS) {
        s.decision = "timeout";
      }
    },
    decision: function () { return s.decision; },
    // Seconds from the first full draw, for the log.
    secondsDrawn: function (now) {
      var t = clock(now);
      return s.firstDrawnAt >= 0 ? Math.round((t - s.firstDrawnAt) / 100) / 10 : 0;
    },
    view: function (now) {
      var t = clock(now);
      if (!s.open) return { open: false, allowReady: false, progress: 0, countdown: 0, hint: "", decision: s.decision };
      var enabledAt = s.drawnAt >= 0 ? s.drawnAt + BOX_DELAY_MS : -1;
      var remaining = s.firstDrawnAt >= 0 ? Math.max(0, BOX_TIMEOUT_MS - (t - s.firstDrawnAt)) : BOX_TIMEOUT_MS;
      return {
        open: true,
        allowReady: enabledAt >= 0 && t >= enabledAt,
        progress: enabledAt < 0 ? 0 : Math.min(1, Math.max(0, (t - s.drawnAt) / BOX_DELAY_MS)),
        countdown: (s.firstDrawnAt >= 0 && remaining <= BOX_COUNTDOWN_MS) ? Math.ceil(remaining / 1000) : 0,
        hint: s.hint,
        decision: s.decision
      };
    }
  };
}

// ---------------------------------------------------------------- one desk: the request from propose to the last step
// ports (all given by the QML service; fakes in the tests):
//   runProcess(argv)            start THE tracked process; the service later calls desk.processDone({code, out})
//   killProcess(hard)           SIGTERM, or SIGKILL when hard
//   exec(argv)                  run a detached command (no result)
//   snapshot()                  {monitor:{name,dpms}|null, screens:[name], activeAddress, activeWorkspace, activeLayout,
//                                workspaces:[{id,layout}], windows:[{address,stableId,pid,cls,initialClass,workspaceId,
//                                workspaceName,floating,fullscreen,focused,focusHistoryID,mapped}]}
//   refresh()                   ask Hyprland for fresh window, workspace and monitor data
//   requestFrame()              ask the box window for another frame (QQuickWindow.update), until a frame arrives
//   showBox(content, screen)    hideBox()
//   showWelcome(info)           info.marker is the path to write, or ""
//   writeLog(text)              logReady(path)
//   env()                       {home, stateDir}
//   sync()                      "look at needsTick() and the box view now"
function createDesk(V, ports) {
  var MSG = V.MSG;
  var guard = createGuard(V);
  var seen = createSeenIds(V.LIMITS.maxIds);
  var records = createRecords(V);
  var box = createBoxModel(V);
  var cur = null;
  var lastNow = 0;
  var procQ = [];
  var proc = null;
  var logLines = [];
  var logState = "pending"; // pending | ok | failed
  var logDirty = false;
  var logWrittenAt = -1;
  var paths = null;
  var welcome = { open: false, pending: false };
  var started = false;
  var refreshAt = 0;

  function touch(now) {
    var t = Number(now);
    lastNow = isFinite(t) ? t : lastNow;
    return lastNow;
  }
  function sync() { try { ports.sync(); } catch (e) { /* the service decides what to do */ } }
  function snap() {
    try {
      var sn = ports.snapshot();
      if (sn && typeof sn === "object") return sn;
    } catch (e) { /* fall through */ }
    return { monitor: null, screens: [], activeAddress: "", activeWorkspace: 0, activeLayout: "", workspaces: [], windows: [] };
  }
  function reply(o) { return JSON.stringify(o); }

  // ---- log (spec 10.1): ASCII lines, the last 200 in memory, written whole by the service
  function log(now, id, event, detail) {
    var iso = "0000-00-00T00:00:00.000Z";
    try { iso = new Date(now).toISOString(); } catch (e) { /* keep the placeholder */ }
    var line = V.asciiLine(iso + " " + (id ? String(id).slice(0, 8) : "--------") + " " + event + (detail ? " " + detail : ""), 200);
    logLines.push(line);
    if (logLines.length > 200) logLines.shift();
    logDirty = true;
  }
  function flushLog(now) {
    if (!logDirty) return;
    if (logState === "failed") {
      logDirty = false;
      return;
    }
    if (logState === "ok" && (logWrittenAt < 0 || now - logWrittenAt >= 200)) {
      logDirty = false;
      logWrittenAt = now;
      try { ports.writeLog(logLines.join("\n") + "\n"); } catch (e) { /* nothing is logged then */ }
    }
  }

  // ---- the one tracked process at a time (spec 8)
  function runProc(argv, timeoutMs, cb) {
    procQ.push({ argv: argv, timeoutMs: timeoutMs, cb: cb, queuedAt: lastNow });
    pump();
  }
  function pump() {
    if (proc || procQ.length === 0) return;
    var job = procQ.shift();
    proc = { job: job, startedAt: lastNow, timedOut: false, delivered: false, hardAt: -1 };
    try {
      ports.runProcess(job.argv);
    } catch (e) {
      proc = null;
      job.cb({ code: -1, out: "", timedOut: false });
      pump();
    }
  }
  // The service calls this when the process ended, and also when none was running or it never started (code -1, no output):
  // the slot is then free at once (review C7).
  function processDone(res, now) {
    touch(now);
    if (!proc) return;
    var p = proc;
    proc = null;
    if (!p.delivered) {
      p.delivered = true;
      p.job.cb({ code: Number(res && res.code), out: String(res && res.out !== undefined ? res.out : ""), timedOut: p.timedOut });
    }
    pump();
    sync();
  }
  // A process is stopped with SIGTERM at its time and with SIGKILL a second later. The slot is only free again when the
  // process has really ended, so a late answer can never be taken for the next process. A port that finds nothing running
  // frees the slot from inside killProcess; p is then already answered, and proc may already be the next process.
  function procTimers(now) {
    var p = proc;
    if (p) {
      if (!p.timedOut && now - p.startedAt >= p.job.timeoutMs) {
        p.timedOut = true;
        p.hardAt = now + PROC_KILL_GRACE_MS;
        try { ports.killProcess(false); } catch (e) { /* the hard kill follows */ }
        if (!p.delivered) {
          p.delivered = true;
          p.job.cb({ code: -1, out: "", timedOut: true });
        }
      } else if (p.timedOut && p.hardAt >= 0 && now >= p.hardAt && proc === p) {
        p.hardAt = -1;
        try { ports.killProcess(true); } catch (e) { /* nothing more to do */ }
      }
    }
    // A job that waits more than 5 s behind a process that will not end gives up, so a request cannot hang.
    if (procQ.length > 0) {
      var waiting = procQ;
      procQ = [];
      var keep = [];
      for (var i = 0; i < waiting.length; i++) {
        if (now - waiting[i].queuedAt > 5000) waiting[i].cb({ code: -1, out: "", timedOut: true });
        else keep.push(waiting[i]);
      }
      procQ = keep.concat(procQ);
    }
  }

  // ---- ending a request
  function finish(now, state, message, event, outcome) {
    var c = cur;
    if (!c) return;
    records.finish(c.id, state, message, c.steps, now);
    log(now, c.id, event);
    var paused = guard.ended(now, outcome);
    if (paused === "paused-10m") log(now, null, "paused 10m");
    if (paused === "paused-1h") log(now, null, "paused 1h");
    if (box.isOpen()) {
      box.close();
      try { ports.hideBox(); } catch (e) { /* ignore */ }
    }
    cur = null;
    if (welcome.pending) {
      welcome.pending = false;
      showWelcome(now);
    }
  }
  function refuseCurrent(now, message, word) {
    guard.invalid(now);
    finish(now, "refused", message, "refused:" + word, "refused");
  }
  function notify(text) {
    try { ports.exec(["notify-send", "-a", "Omacommand", text]); } catch (e) { /* notify-send is optional */ }
  }

  // ---- propose (spec 6.3): the checks run cheapest first
  function refuse(now, id, word, message, count) {
    if (count) guard.invalid(now);
    guard.ended(now, "refused");
    log(now, id, "refused:" + word);
    return reply({ v: 1, ok: false, state: "refused", message: message });
  }

  function propose(text, now) {
    touch(now);
    now = lastNow;
    var out = proposeChecked(text, now);
    flushLog(now);
    sync();
    return out;
  }

  function proposeChecked(text, now) {
    if (typeof text !== "string") text = "";
    if (text.length > V.LIMITS.maxRequestChars) return refuse(now, null, "size", MSG.tooLarge, true);
    var rl = guard.check(now);
    if (rl) {
      log(now, null, "refused:" + rl.word);
      return reply({ v: 1, ok: false, state: "refused", message: rl.message });
    }
    if (V.nestingTooDeep(text)) return refuse(now, null, "nesting", MSG.tooLarge, true);
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return refuse(now, null, "parse", MSG.badRequest, true); }
    var env = V.checkEnvelope(obj);
    if (!env.ok) return refuse(now, null, "shape", env.message, true);
    if (seen.has(env.id)) return refuse(now, env.id, "replay", MSG.idUsed, true);
    seen.add(env.id);
    if (!V.checkSentAt(env.sentAt, now)) return refuse(now, env.id, "time", MSG.wrongTime, true);
    if (cur) return refuse(now, env.id, "busy", MSG.busy, true);
    if (welcome.open) return refuse(now, env.id, "welcome", MSG.welcomeOpen, true);
    var vp = V.validatePlan(env.plan);
    if (!vp.ok) return refuse(now, env.id, "plan", vp.message, true);

    cur = {
      id: env.id, plan: vp.plan, phase: "lock", steps: [], prep: { folders: [], closes: [] },
      closed: {}, bound: {}, run: null, screen: "", fi: 0, waitUntil: 0, content: null
    };
    records.create(env.id);
    log(now, env.id, "proposed", "steps=" + V.planSummary(vp.plan) + " " + V.logClient(env.client));
    startLockCheck(now);
    return reply({ v: 1, ok: true, id: env.id });
  }

  // ---- preparing the box (spec 3.4, 5.4, 5.5)
  function startLockCheck(now) {
    var c = cur;
    runProc(["omarchy-shell", "lock", "isLocked"], 2000, function (res) {
      if (cur !== c) return;
      var ans = V.lastLine(res.out);
      if (res.timedOut || res.code !== 0 || (ans !== "true" && ans !== "false")) return refuseCurrent(lastNow, MSG.lockUnknown, "lock-unknown");
      if (ans === "true") return refuseCurrent(lastNow, MSG.locked, "locked");
      afterLock(lastNow);
    });
  }

  function afterLock(now) {
    var sn = snap();
    var m = sn.monitor;
    var okScreen = false;
    if (m && typeof m.name === "string" && m.name !== "" && m.dpms !== false && m.name.indexOf("HEADLESS-") !== 0) {
      var names = sn.screens || [];
      for (var i = 0; i < names.length; i++) if (names[i] === m.name) okScreen = true;
    }
    if (!okScreen) return refuseCurrent(now, MSG.noScreen, "no-screen");
    cur.screen = m.name;
    cur.fi = 0;
    nextFolder(now);
  }

  function nextFolder(now) {
    var c = cur;
    for (var i = c.fi; i < c.plan.steps.length; i++) {
      var st = c.plan.steps[i];
      if (st["do"] === "open" && V.hasOwn(st, "folder")) {
        c.fi = i + 1;
        resolveFolder(i, now);
        return;
      }
    }
    startSpotifyCheck(now);
  }

  // An "open Spotify" step needs the app to be there. Omarchy's own launcher would start a program that adds software when
  // it is missing, so that launcher is never used, and the box is not shown at all (review C3).
  function startSpotifyCheck(now) {
    var c = cur;
    var n = 0;
    for (var i = 0; i < c.plan.steps.length && n === 0; i++) {
      var st = c.plan.steps[i];
      if (st["do"] === "open" && st.app === "spotify") n = i + 1;
    }
    if (n === 0) return startCloses(now);
    runProc(V.SPOTIFY_CHECK.slice(), 2000, function (res) {
      if (cur !== c) return;
      if (res.timedOut || res.code !== 0) return refuseCurrent(lastNow, "Step " + n + ": " + MSG.spotifyMissing, "spotify-missing");
      startCloses(lastNow);
    });
  }

  function resolveFolder(i, now) {
    var c = cur;
    var step = c.plan.steps[i];
    var n = i + 1;
    var home = "";
    try { home = String(ports.env().home); } catch (e) { home = ""; }
    var outside = "Step " + n + ": that folder is not in the home folder.";
    var missing = "Step " + n + ": that folder does not exist.";
    if (!V.isSafeHome(home)) return refuseCurrent(now, outside, "folder-outside");
    var rel = V.folderRel(step.folder);
    var path = rel === "" ? home : home + "/" + rel;
    runProc(["realpath", "-e", "--", path], 2000, function (res) {
      if (cur !== c) return;
      if (res.timedOut || res.code !== 0) return refuseCurrent(lastNow, missing, "folder-missing");
      var r = V.checkRealFolder(home, V.lastLine(res.out));
      if (!r.ok) return refuseCurrent(lastNow, outside, "folder-outside");
      runProc(["test", "-d", r.real], 2000, function (res2) {
        if (cur !== c) return;
        if (res2.timedOut || res2.code !== 0) return refuseCurrent(lastNow, missing, "folder-missing");
        c.prep.folders[i] = { real: r.real, shown: V.displayRel(rel), link: r.rel !== rel ? V.displayRel(r.rel) : null };
        nextFolder(lastNow);
      });
    });
  }

  function isClose(step) { return step["do"] === "window" && step.what === "close"; }

  function startCloses(now) {
    var c = cur;
    var any = false;
    for (var i = 0; i < c.plan.steps.length; i++) if (isClose(c.plan.steps[i])) any = true;
    if (!any) return showBox(now);
    try { ports.refresh(); } catch (e) { /* the binding below then fails closed */ }
    c.phase = "closeWait";
    c.waitUntil = now + REFRESH_WAIT_MS;
  }

  function bindCloses(now) {
    var c = cur;
    var sn = snap();
    for (var i = 0; i < c.plan.steps.length; i++) {
      if (!isClose(c.plan.steps[i])) continue;
      var r = V.findCloseTarget(c.plan.steps[i], i + 1, sn);
      if (!r.ok) return refuseCurrent(now, r.message, "close");
      if (V.hasOwn(c.closed, r.binding.address)) return refuseCurrent(now, MSG.windowChangedWhilePreparing, "close-changed");
      c.prep.closes[i] = r.binding;
      c.bound[r.binding.address] = true;
    }
    showBox(now);
  }

  function showBox(now) {
    var c = cur;
    var b = V.buildBoxLines(c.plan, c.prep);
    if (!b.ok) return refuseCurrent(now, b.message, "text");
    c.content = { title: V.BOX_TITLE, lines: b.lines, note: b.hasClose ? V.BOX_CLOSE_NOTE : "", footer: V.BOX_FOOTER };
    c.phase = "box";
    box.show(now, c.screen);
    log(now, c.id, "shown");
    try {
      ports.showBox(c.content, c.screen);
    } catch (e) {
      box.close();
      refuseCurrent(now, MSG.noScreen, "show-failed");
    }
  }

  // ---- the box decides (spec 3.4, 3.8)
  function afterBox(now) {
    if (!cur || cur.phase !== "box") return;
    var d = box.decision();
    if (d) boxDecided(d, now);
  }

  function boxDecided(d, now) {
    var c = cur;
    var seconds = box.secondsDrawn(now);
    // Close the model and leave the "box" phase BEFORE the window is hidden. Hiding it makes the window report itself back
    // (onVisibleChanged), and that report must find nothing left to decide, or Allow would run twice (review C10).
    box.close();
    c.phase = d === "allow" ? "run" : "ended";
    try { ports.hideBox(); } catch (e) { /* ignore */ }
    if (d === "allow") {
      // The run checks the frozen plan again, and it must be the very plan the person saw (spec 5.7).
      var again = V.validatePlan(c.plan);
      if (!again.ok || JSON.stringify(again.plan) !== JSON.stringify(c.plan)) {
        finish(now, "failed", MSG.internal, "revalidate-failed", "failed");
        return;
      }
      records.update(c.id, { state: "running", message: MSG.running });
      log(now, c.id, "allowed after " + seconds + "s");
      c.run = { i: 0, ops: null, o: 0, st: {}, extra: "", opened: {}, wait: { kind: "until", at: now + RUN_START_DELAY_MS } };
    } else if (d === "deny") {
      finish(now, "denied", MSG.denied, "denied", "deny");
    } else if (d === "denypause") {
      finish(now, "denied", MSG.denied, "denied", "denypause");
    } else if (d === "timeout") {
      finish(now, "timeout", MSG.timeout, "timeout", "timeout");
    } else {
      finish(now, "denied", MSG.windowClosed, "window-closed", "autodeny");
    }
  }

  // ---- running the steps (spec 5.5, 8)
  function stepCtx(i) { return { folder: cur.prep.folders[i], close: cur.prep.closes[i] }; }
  function stepNote(i, result) { return V.asciiLine(V.stepWords(cur.plan.steps[i], stepCtx(i)) + ": " + result, 120); }
  function bad(reason, word) { return { fail: reason, word: word }; }

  function sendProc(argv, timeoutMs) {
    var c = cur;
    var r = c.run;
    r.wait = { kind: "proc" };
    runProc(argv, timeoutMs, function (res) {
      if (cur !== c || c.run !== r) return;
      r.st.res = res;
      r.wait = null;
      advance(lastNow);
    });
  }
  function sendLua(luaText) { sendProc(["hyprctl", "-i", "0", "dispatch", luaText], 3000); }

  // "next" when Hyprland said ok, else a failure.
  function dispatchResult(res) {
    if (res.timedOut) return bad("Hyprland did not answer in time", "dispatch-timeout");
    if (res.out.length > 4096) return bad("Hyprland gave an answer that was too long", "dispatch");
    var ans = V.lastLine(res.out);
    if (res.code === 0 && ans === "ok") return "next";
    var clean = V.asciiLine(ans, 100);
    return bad(clean ? "Hyprland said: " + clean : "Hyprland did not accept it", "dispatch");
  }

  function waitUntil(r, now, ms) { r.wait = { kind: "until", at: now + ms }; }

  function advance(now) {
    var c = cur;
    for (var n = 0; n < 200 && c && cur === c && c.phase === "run"; n++) {
      var r = c.run;
      if (r.wait) return;
      if (!r.ops) {
        if (r.i >= c.plan.steps.length) return endRun(now);
        try {
          var folder = c.prep.folders[r.i];
          r.ops = V.planOps(c.plan.steps[r.i], { folderReal: folder ? folder.real : undefined });
        } catch (e) {
          return stepFail(now, "an internal error stopped this step", "internal");
        }
        r.o = 0;
        r.st = {};
        r.extra = "";
      }
      if (r.o >= r.ops.length) {
        c.steps.push({ ok: true, note: stepNote(r.i, "done" + (r.extra ? " (" + r.extra + ")" : "")) });
        records.update(c.id, { steps: c.steps.slice() });
        r.i++;
        r.ops = null;
        continue;
      }
      var res = doOp(r.ops[r.o], now);
      if (res === "wait") return;
      if (res === "next") {
        r.o++;
        r.st = {};
        continue;
      }
      return stepFail(now, res.fail, res.word);
    }
  }

  function doOp(op, now) {
    var r = cur.run;
    var st = r.st;
    if (op.t === "lua") {
      if (!st.sent) {
        var addr = null;
        if (op.win) {
          var sn = snap();
          addr = V.resolveWindow(op.win.app, sn.windows || [], r.opened, sn.activeAddress);
          if (!addr) return bad(op.win.app ? V.APPS[op.win.app].name + " is not open" : "there is no current window", "no-window");
        }
        var text;
        try { text = V.luaFor(op, addr); } catch (e) { return bad("an internal error stopped this step", "internal"); }
        st.sent = true;
        sendLua(text);
        return "wait";
      }
      return dispatchResult(st.res);
    }
    if (op.t === "exec") {
      if (!st.done) {
        st.done = true;
        try { ports.exec(op.argv); } catch (e) { return bad("the command could not be started", "exec"); }
        waitUntil(r, now, SETTLE_MS);
        return "wait";
      }
      return "next";
    }
    if (op.t === "run") return opRun(op, now);
    if (op.t === "layout") return opLayout(op, now);
    if (op.t === "open") return opOpen(op, now);
    if (op.t === "close") return opClose(op, now);
    return bad("an internal error stopped this step", "internal");
  }

  // A short system command (volume, brightness, music) runs as the tracked process, so its exit code is known: a command
  // that is missing or fails is reported as a failed step instead of "done" (review C4).
  function opRun(op, now) {
    var r = cur.run;
    var st = r.st;
    if (!st.sent) {
      st.sent = true;
      sendProc(op.argv, RUN_TIMEOUT_MS);
      return "wait";
    }
    if (!st.settled) {
      var res = st.res;
      if (res.timedOut) return bad("the command did not finish in time", "command-timeout");
      if (res.code !== 0) return bad("the command ended with an error", "command");
      st.settled = true;
      waitUntil(r, now, SETTLE_MS); // the same pause as after every started command
      return "wait";
    }
    return "next";
  }

  // The layout is read from Quickshell's copy of the workspace, which can be stale or still empty (a new workspace is filled
  // in by a later refresh), and the toggle changes the layout through a Hyprland call that raises no event Quickshell
  // refreshes on. So: refresh and wait before reading, refresh and read again after the toggle, and fail the step if the
  // layout is not the one asked for (review C5).
  function opLayout(op, now) {
    var r = cur.run;
    var st = r.st;
    if (!st.stage) {
      try { ports.refresh(); } catch (e) { /* the read below then fails closed */ }
      st.stage = "read";
      waitUntil(r, now, REFRESH_WAIT_MS);
      return "wait";
    }
    if (st.stage === "read") {
      var raw = snap().activeLayout;
      var current = V.layoutWord(raw);
      if (current === op.mode) {
        r.extra = "it already was";
        return "next";
      }
      // The toggle looks at the real layout itself. With nothing known about it, a toggle could undo what was asked for.
      if (typeof raw !== "string" || raw === "") return bad("the layout of this workspace could not be read", "layout-unknown");
      if (op.mode === "scrolling" && current === "other") return bad("this workspace uses a layout Omacommand does not know", "layout");
      st.stage = "toggled";
      try { ports.exec(op.argv); } catch (e) { return bad("the command could not be started", "exec"); }
      waitUntil(r, now, SETTLE_MS);
      return "wait";
    }
    if (st.stage === "toggled") {
      try { ports.refresh(); } catch (e) { /* the check below then fails closed */ }
      st.stage = "verify";
      waitUntil(r, now, REFRESH_WAIT_MS);
      return "wait";
    }
    if (V.layoutWord(snap().activeLayout) !== op.mode) return bad("the layout is not the one asked for", "layout-check");
    return "next";
  }

  function opOpen(op, now) {
    var r = cur.run;
    var st = r.st;
    var res;
    if (!st.stage) {
      var sn = snap();
      var wins = sn.windows || [];
      if (op.reuse) {
        var existing = V.resolveWindow(op.app, wins, {}, null);
        if (existing) {
          st.stage = "focused";
          st.addr = existing;
          r.extra = "it was already open, so it switched to it";
          sendLua(V.lua("focus_window", { addr: existing }));
          return "wait";
        }
      }
      st.baseline = {};
      for (var i = 0; i < wins.length; i++) st.baseline[wins[i].address] = true;
      if (op.place) {
        st.stage = "preselected";
        sendLua(V.preselectLua(op.place));
        return "wait";
      }
      return launch(op, now);
    }
    if (st.stage === "focused") {
      res = dispatchResult(st.res);
      if (res === "next") r.opened[op.app] = st.addr;
      return res;
    }
    if (st.stage === "preselected") {
      res = dispatchResult(st.res);
      if (res !== "next") return res;
      return launch(op, now);
    }
    if (st.stage === "launched") {
      if (st.found) {
        r.opened[op.app] = st.found;
        return "next";
      }
      return bad("the app did not open in time", "open-timeout");
    }
    return bad("an internal error stopped this step", "internal");
  }

  function launch(op, now) {
    var r = cur.run;
    try { ports.exec(op.argv); } catch (e) { return bad("the app could not be started", "exec"); }
    r.st.stage = "launched";
    r.wait = { kind: "open", app: op.app, baseline: r.st.baseline, deadline: now + OPEN_WAIT_MS, scanAt: now + 250, found: "" };
    return "wait";
  }

  function checkOpenWait(now) {
    var r = cur.run;
    var w = r.wait;
    if (!w.found && now >= w.scanAt) {
      w.scanAt = now + 250;
      var wins = snap().windows || [];
      for (var i = 0; i < wins.length; i++) {
        var x = wins[i];
        if (x.mapped !== false && !w.baseline[x.address] && V.appForClass(x.cls) === w.app) {
          w.found = x.address;
          break;
        }
      }
    }
    if (w.found) {
      r.st.found = w.found;
      r.wait = null;
    } else if (now >= w.deadline) {
      r.wait = null;
    }
  }

  function opClose(op, now) {
    var c = cur;
    var r = c.run;
    var st = r.st;
    var b = c.prep.closes[r.i];
    if (!b) return bad("an internal error stopped this step", "internal");
    if (!st.stage) {
      if (V.hasOwn(c.closed, b.address)) return bad(MSG.gone.replace(/\.$/, ""), "gone");
      try { ports.refresh(); } catch (e) { /* the check below fails closed */ }
      st.stage = "verify";
      waitUntil(r, now, REFRESH_WAIT_MS);
      return "wait";
    }
    if (st.stage === "verify") {
      var v = V.verifyBinding(b, snap().windows || [], c.closed);
      if (!v.ok) return bad(v.message.replace(/\.$/, ""), v.message === MSG.gone ? "gone" : "changed");
      st.stage = "sent";
      sendLua(V.lua("close", { addr: b.address }));
      return "wait";
    }
    return dispatchResult(st.res);
  }

  function stepFail(now, reason, word) {
    var c = cur;
    var i = c.run.i;
    var n = c.plan.steps.length;
    c.steps.push({ ok: false, note: stepNote(i, "failed (" + reason + ")") });
    finish(now, "failed", "Step " + (i + 1) + " failed: " + reason + ". The steps after it did not run.",
      "failed at " + (i + 1) + "/" + n + ": " + word, "failed");
    notify("An AI agent's request stopped at step " + (i + 1) + ".");
  }

  function endRun(now) {
    var n = cur.plan.steps.length;
    finish(now, "done", "The person allowed it. " + (n === 1 ? "The step ran." : "All " + n + " steps ran."), "ran ok " + n + "/" + n, "done");
    notify("An AI agent's request ran (" + n + (n === 1 ? " step" : " steps") + ").");
  }

  // ---- Hyprland's events (spec 5.5, 5.6)
  function hyprEvent(name, data, now) {
    touch(now);
    now = lastNow;
    try {
      handleEvent(String(name), String(data), now);
    } catch (e) { /* an event must never break the shell */ }
    sync();
  }

  function handleEvent(name, data, now) {
    if (name === "openwindow") {
      var f = data.split(",");
      var addr = V.normAddr(f[0]);
      if (!addr) return;
      if (cur && V.hasOwn(cur.bound, addr)) cur.closed[addr] = true;
      var w = cur && cur.run && cur.run.wait;
      if (w && w.kind === "open" && !w.baseline[addr] && V.appForClass(f[2]) === w.app) w.found = addr;
      if (!refreshAt) refreshAt = now + EVENT_REFRESH_MS;
    } else if (name === "windowtitlev2") {
      var a2 = V.normAddr(data.split(",")[0]);
      var w2 = cur && cur.run && cur.run.wait;
      if (a2 && w2 && w2.kind === "open" && !w2.baseline[a2] && !refreshAt) refreshAt = now + EVENT_REFRESH_MS;
    } else if (name === "closewindow") {
      var a3 = V.normAddr(data);
      if (!a3) return;
      // Bound addresses are always recorded. Only the others stop at 256, so a flood of events cannot grow the set, and
      // such a flood can never make a bound window fall back on the pid and stable id alone (review C11).
      if (cur && (V.hasOwn(cur.bound, a3) || Object.keys(cur.closed).length < 256)) cur.closed[a3] = true;
      if (cur && cur.phase === "box" && V.hasOwn(cur.bound, a3)) {
        box.abort("windowclosed");
        afterBox(now);
      }
      if (!refreshAt) refreshAt = now + EVENT_REFRESH_MS;
    } else if (name === "movewindow" || name === "movewindowv2") {
      if (!refreshAt) refreshAt = now + EVENT_REFRESH_MS;
    }
  }

  // ---- startup: the state folder, the log, the welcome note (spec 3.9, 10.1)
  function start(now) {
    touch(now);
    if (started) return;
    started = true;
    var env = { home: "", stateDir: "" };
    try { env = ports.env(); } catch (e) { /* the log then stays off */ }
    var dir = String(env.stateDir);
    if (!V.isSafeRealPath(dir)) {
      logState = "failed";
      checkWelcome();
      sync();
      return;
    }
    paths = { dir: dir, log: dir + "/events.log", log1: dir + "/events.1.log", marker: dir + "/welcome-1" };
    runProc(["mkdir", "-p", "-m", "700", "--", dir], 2000, function (res) {
      if (res.timedOut || res.code !== 0) {
        logState = "failed";
        checkWelcome();
        return;
      }
      // The first write waits for this: a write into a missing folder would make it with the default mode.
      runProc(["mv", "-f", "--", paths.log, paths.log1], 2000, function () {
        logState = "ok";
        try { ports.logReady(paths.log); } catch (e) { logState = "failed"; }
        log(lastNow, null, "started");
        checkWelcome();
      });
    });
    sync();
  }

  function checkWelcome() {
    if (!paths) {
      welcomeDue(lastNow);
      return;
    }
    runProc(["test", "-e", paths.marker], 2000, function (res) {
      if (res.timedOut || res.code === 0) return; // there already, or no answer: say nothing
      welcomeDue(lastNow);
    });
  }
  function welcomeDue(now) {
    if (cur) {
      welcome.pending = true;
      return;
    }
    showWelcome(now);
  }
  function showWelcome(now) {
    if (welcome.open) return;
    welcome.open = true;
    log(now, null, "welcome");
    try { ports.showWelcome({ marker: (logState === "ok" && paths) ? paths.marker : "" }); } catch (e) { welcome.open = false; }
  }

  // ---- the public face
  function needsTick() {
    return !!(cur || proc || procQ.length > 0 || refreshAt || (logDirty && logState === "ok"));
  }

  function tick(now) {
    touch(now);
    now = lastNow;
    procTimers(now);
    if (cur) {
      if (cur.phase === "box") {
        box.tick(now);
        afterBox(now);
        // After any restart of the delay the window gets no frame of its own (a box that does not change draws nothing),
        // so one is asked for on every tick until it arrives (review C1).
        if (cur && cur.phase === "box" && box.wantsFrame()) {
          try { ports.requestFrame(); } catch (e) { /* the box then waits for a frame from the window itself */ }
        }
      } else if (cur.phase === "closeWait" && now >= cur.waitUntil) {
        bindCloses(now);
      }
      if (cur && cur.phase === "run" && cur.run) {
        var w = cur.run.wait;
        if (w && w.kind === "until" && now >= w.at) cur.run.wait = null;
        else if (w && w.kind === "open") checkOpenWait(now);
        if (cur && cur.phase === "run" && !cur.run.wait) advance(now);
      }
    }
    if (refreshAt && now >= refreshAt) {
      refreshAt = 0;
      try { ports.refresh(); } catch (e) { /* ignore */ }
    }
    flushLog(now);
    sync();
  }

  function boxCall(fn) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var now = touch(args[args.length - 1]);
      args[args.length - 1] = now;
      fn.apply(null, args);
      afterBox(now);
      flushLog(now);
      sync();
    };
  }

  return {
    ping: function () { return reply({ v: 1, name: "omacommand", version: V.VERSION, ready: true }); },
    propose: propose,
    status: function (id, now) { touch(now); return records.json(id, lastNow); },
    state: function (now) {
      touch(now);
      if (!guard.allowState(lastNow)) return reply({ v: 1, ok: false, message: MSG.stateRate });
      log(lastNow, null, "state");
      var out = reply(V.buildState(snap()));
      flushLog(lastNow);
      sync();
      return out;
    },
    start: start,
    tick: tick,
    processDone: processDone,
    hyprEvent: hyprEvent,
    needsTick: needsTick,
    welcomeClosed: function (now) {
      touch(now);
      welcome.open = false;
      sync();
    },
    // An unexpected error somewhere in the service (spec 8): one fixed word in the log, the request that is open becomes
    // failed, and its box closes. Otherwise a throw inside tick would repeat every 50 ms and the box would never time out
    // (review C6). Once the steps have started, "Nothing ran" would not be true, so the sentence says so.
    noteInternal: function (word, now) {
      touch(now);
      var w = String(word).replace(/[^a-z-]/g, "").slice(0, 20);
      if (cur) finish(lastNow, "failed", cur.phase === "run" ? MSG.internalRunning : MSG.internal, "internal-error:" + w, "failed");
      else log(lastNow, null, "internal-error:" + w);
      flushLog(lastNow);
      sync();
    },
    boxContent: function () { return cur && cur.content ? cur.content : null; },
    boxView: function (now) { return box.view(touch(now)); },
    box: {
      visible: boxCall(function (v, now) { box.visibleChanged(v, now); }),
      size: boxCall(function (ok, now) { box.geometry(ok, now); }),
      frame: boxCall(function (now) { box.frame(now); }),
      active: boxCall(function (a, now) { box.activeChanged(a, now); }),
      screen: boxCall(function (k, now) { box.screenChanged(k, now); }),
      pointerAt: boxCall(function (gx, gy, now) { box.pointerAt(gx, gy, now); }),
      press: boxCall(function (kind, now) { box.press(kind, now); }),
      release: boxCall(function (inside, now) { box.release(inside, now); }),
      key: boxCall(function (name, repeat, now) { box.key(name, repeat, now); }),
      deny: boxCall(function (now) { box.deny(now); }),
      denyPause: boxCall(function (now) { box.denyPause(now); })
    }
  };
}

var ModelApi = {
  createGuard: createGuard, createSeenIds: createSeenIds, createRecords: createRecords,
  createBoxModel: createBoxModel, createDesk: createDesk,
  BOX_DELAY_MS: BOX_DELAY_MS, BOX_TIMEOUT_MS: BOX_TIMEOUT_MS, BOX_UNDRAWN_MS: BOX_UNDRAWN_MS,
  RUN_START_DELAY_MS: RUN_START_DELAY_MS, SETTLE_MS: SETTLE_MS, REFRESH_WAIT_MS: REFRESH_WAIT_MS, OPEN_WAIT_MS: OPEN_WAIT_MS,
  RUN_TIMEOUT_MS: RUN_TIMEOUT_MS, MOTION_EPS: MOTION_EPS,
  HINT_CLICK: HINT_CLICK, HINT_WAIT: HINT_WAIT, HINT_MOVE: HINT_MOVE
};
