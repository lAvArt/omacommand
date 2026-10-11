import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import "vocab.js" as Vocab
import "box_model.js" as BoxModel

// Omacommand service (spec 3.1). The root declares no functions and no properties, so a future shell that routes
// calls to services would find nothing here. All logic lives in `engine` and in the two JS files. QML never reads a file.
Item {
  id: root

  Component.onCompleted: engine.start()

  QtObject {
    id: engine

    property var desk: null
    property string logPath: ""
    property var run: null

    function start() {
      try {
        desk = BoxModel.ModelApi.createDesk(Vocab.VocabApi, ports())
        allowBox.desk = desk
        desk.start(Date.now())
      } catch (e) {
        console.warn("omacommand: start failed")
      }
    }

    // ---- what the JS model may ask of the shell
    function ports() {
      return {
        runProcess: function (argv) { engine.startProc(argv) },
        killProcess: function (hard) { engine.killProc(hard) },
        exec: function (argv) { Quickshell.execDetached(argv) },
        snapshot: function () { return engine.snapshot() },
        refresh: function () { engine.refreshHypr() },
        requestFrame: function () { allowBox.requestFrame() },
        showBox: function (content, screenName) { engine.showBox(content, screenName) },
        hideBox: function () { allowBox.visible = false },
        showWelcome: function (info) { engine.showWelcome(info) },
        writeLog: function (text) { logFile.setText(text) },
        logReady: function (path) { engine.logPath = path },
        env: function () { return engine.env() },
        sync: function () { engine.sync() }
      }
    }

    function env() {
      var home = String(Quickshell.env("HOME") || "")
      var xdg = String(Quickshell.env("XDG_STATE_HOME") || "")
      var base = xdg.charAt(0) === "/" ? xdg : home + "/.local/state"
      return { home: home, stateDir: base + "/omacommand" }
    }

    function sync() {
      if (!desk) return
      ticker.running = desk.needsTick()
      if (allowBox.visible) allowBox.view = desk.boxView(Date.now())
    }

    function onTick() {
      try {
        desk.tick(Date.now())
      } catch (e) {
        noteInternal("tick")
      }
    }

    function noteInternal(word) {
      try { desk.noteInternal(word, Date.now()) } catch (e2) { console.warn("omacommand: internal error") }
    }

    // ---- the IpcHandler's four answers
    function ping() { return desk ? desk.ping() : Vocab.VocabApi.NOT_READY }
    function propose(request) { return desk.propose(request, Date.now()) }
    function status(id) { return desk.status(id, Date.now()) }
    function state() { return desk.state(Date.now()) }

    // ---- processes: one tracked process at a time, run by the model
    function startProc(argv) {
      run = { code: -1, exited: false, streamed: false, done: false, lost: false }
      proc.command = argv
      proc.running = true
    }
    function killProc(hard) {
      try {
        // Nothing runs (it never started, or was stopped before it started): Quickshell emits no exit, so free the slot now.
        if (!proc.running) procLost()
        else if (hard) proc.signal(9)
        else proc.running = false
      } catch (e) {
        noteInternal("kill")
      }
    }
    function procStream() {
      if (!run) return
      run.streamed = true
      if (run.exited) procFinish()
    }
    function procExit(code) {
      if (!run) return
      run.exited = true
      run.code = Number(code)
      if (run.streamed) procFinish()
      else graceTimer.restart()
    }
    // The process is gone and no exit was seen: the start failed, or it was stopped before it started. Quickshell 0.3.1
    // emits no `exited` then, so without this the slot would stay taken until the plugin reloads (review C7).
    function procLost() {
      if (!run || run.exited || run.done) return
      run.exited = true
      run.lost = true
      run.code = -1
      procFinish()
    }
    function procFinish() {
      if (!run || run.done) return
      run.done = true
      graceTimer.stop()
      var out = run.lost ? "" : String(collector.text)
      try {
        desk.processDone({ code: run.code, out: out }, Date.now())
      } catch (e) {
        noteInternal("process")
      }
    }

    // ---- Hyprland, read through Quickshell.Hyprland only (no hyprctl loops). Window titles are never read.
    function layoutName(o) {
      var t = String((o && o.tiledLayout) || "")
      return /^[a-z]{3,20}$/.test(t) ? t : ""
    }

    function snapshot() {
      var V = Vocab.VocabApi
      var out = { monitor: null, screens: [], activeAddress: "", activeWorkspace: 0, activeLayout: "", workspaces: [], windows: [] }
      var fm = Hyprland.focusedMonitor
      if (fm) {
        var mo = fm.lastIpcObject || ({})
        out.monitor = { name: String(fm.name), dpms: mo.dpmsStatus === false ? false : true }
      }
      var ss = Quickshell.screens
      for (var s = 0; s < ss.length && s < 16; s++) out.screens.push(String(ss[s].name))
      var fw = Hyprland.focusedWorkspace
      if (fw) {
        out.activeWorkspace = Number(fw.id)
        out.activeLayout = layoutName(fw.lastIpcObject)
      }
      var wl = Hyprland.workspaces.values
      for (var w = 0; w < wl.length && w < 64; w++) out.workspaces.push({ id: Number(wl[w].id), layout: layoutName(wl[w].lastIpcObject) })
      var tl = Hyprland.toplevels.values
      for (var i = 0; i < tl.length && i < V.LIMITS.maxClients; i++) {
        var t = tl[i]
        var o = t.lastIpcObject || ({})
        var ws = o.workspace || ({})
        out.windows.push({
          address: V.normAddr(String(t.address || o.address || "")),
          stableId: o.stableId === undefined ? "" : String(o.stableId),
          pid: Number.isInteger(o.pid) ? o.pid : 0,
          cls: typeof o["class"] === "string" ? o["class"] : "",
          initialClass: typeof o.initialClass === "string" ? o.initialClass : "",
          workspaceId: Number.isInteger(ws.id) ? ws.id : 0,
          workspaceName: typeof ws.name === "string" ? ws.name : "",
          floating: o.floating === true,
          fullscreen: o.fullscreen === true || Number(o.fullscreen) > 0,
          focused: t.activated === true,
          focusHistoryID: Number.isInteger(o.focusHistoryID) ? o.focusHistoryID : undefined,
          mapped: o.mapped !== false
        })
      }
      var at = Hyprland.activeToplevel
      if (at) out.activeAddress = V.normAddr(String(at.address || ""))
      return out
    }

    function refreshHypr() {
      try { Hyprland.refreshToplevels() } catch (e) { noteInternal("refresh") }
      try { Hyprland.refreshWorkspaces() } catch (e2) { noteInternal("refresh") }
      try { Hyprland.refreshMonitors() } catch (e3) { noteInternal("refresh") }
    }

    // ---- the boxes
    function screenByName(name) {
      var ss = Quickshell.screens
      for (var i = 0; i < ss.length; i++) if (String(ss[i].name) === name) return ss[i]
      return null
    }

    function showBox(content, screenName) {
      var scr = screenByName(screenName)
      if (!scr) throw new Error("no screen")
      allowBox.screen = scr
      allowBox.content = content
      allowBox.view = desk.boxView(Date.now())
      allowBox.visible = true
    }

    function showWelcome(info) {
      var home = String(Quickshell.env("HOME") || "")
      welcomeBox.serverPath = Vocab.VocabApi.safeServerPath(String(Qt.resolvedUrl("mcp/server.rb")), home)
      var fm = Hyprland.focusedMonitor
      var scr = fm ? screenByName(String(fm.name)) : null
      if (scr) welcomeBox.screen = scr
      welcomeBox.visible = true
      if (info.marker) {
        markerFile.path = info.marker
        markerFile.setText("1\n")
      }
    }

    function welcomeClosed() {
      welcomeBox.visible = false
      try { desk.welcomeClosed(Date.now()) } catch (e) { noteInternal("welcome") }
    }

    function copy(text) {
      Quickshell.execDetached(["wl-copy", "--", String(text)])
    }
  }

  Timer {
    id: ticker
    interval: 50
    repeat: true
    running: false
    onTriggered: engine.onTick()
  }

  Process {
    id: proc
    stdout: StdioCollector {
      id: collector
      onStreamFinished: engine.procStream()
    }
    // A process that was killed by a signal has no real exit code (QProcess::CrashExit is 1), so it counts as a failure.
    onExited: function (exitCode, exitStatus) { engine.procExit(Number(exitStatus) === 1 ? -1 : exitCode) }
    // `exited` always comes before the running state turns false, so a run that is still unfinished here never ended.
    onRunningChanged: { if (!proc.running) engine.procLost() }
  }

  // If the output stream never reports its end, the exit alone finishes the process after a short grace.
  Timer {
    id: graceTimer
    interval: 200
    onTriggered: engine.procFinish()
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      try {
        engine.desk.hyprEvent(String(event.name), String(event.data), Date.now())
      } catch (e) {
        engine.noteInternal("event")
      }
    }
  }

  // The log is only ever written, never read (spec 10.1). The folder is made first, with mode 700, by the model.
  FileView {
    id: logFile
    path: engine.logPath
    preload: false
    watchChanges: false
    printErrors: false
  }

  FileView {
    id: markerFile
    preload: false
    watchChanges: false
    printErrors: false
  }

  IpcHandler {
    target: "io.github.lavart.omacommand"

    function ping(): string {
      try { return engine.ping() } catch (e) { return Vocab.VocabApi.INTERNAL_PLAIN }
    }
    function propose(request: string): string {
      try { return engine.propose(request) } catch (e) { engine.noteInternal("propose"); return Vocab.VocabApi.INTERNAL_PROPOSE }
    }
    function status(id: string): string {
      try { return engine.status(id) } catch (e) { engine.noteInternal("status"); return Vocab.VocabApi.INTERNAL_PLAIN }
    }
    function state(): string {
      try { return engine.state() } catch (e) { engine.noteInternal("state"); return Vocab.VocabApi.INTERNAL_PLAIN }
    }
  }

  AllowBox {
    id: allowBox
  }

  WelcomeBox {
    id: welcomeBox
    onCopyRequested: function (command) { engine.copy(command) }
    onCloseRequested: engine.welcomeClosed()
  }
}
