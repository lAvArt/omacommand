import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Wayland
import qs.Commons as Commons

// The Allow box (spec 3). A PanelWindow on the Overlay layer that the service owns, like the windows of Omarchy's own services.
// The rules (delay, click checks, timeout) are in box_model.js; this file only reports events and draws what the model says.
PanelWindow {
  id: win

  // Given by the service. The text comes from the vocabulary, never from the agent.
  property var desk: null
  property var content: ({ title: "", lines: [], note: "", footer: "" })
  property var view: ({ open: false, allowReady: false, progress: 0, countdown: 0, hint: "", decision: null })
  property bool sizeKnown: false

  visible: false
  color: "transparent"
  anchors { top: true; bottom: true; left: true; right: true }
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
  WlrLayershell.namespace: "omacommand-allow"

  function pick(v, d) { return (v !== undefined && v !== null && String(v) !== "") ? v : d }
  readonly property color urgentColor: pick(Commons.Color.urgent, "#ff6b6b")
  readonly property color mutedColor: pick(Commons.Color.muted, "#9aa3b5")

  // ---- events for the model
  function uiSize() {
    var ok = !!win.screen && scrim.width === win.screen.width && scrim.height === win.screen.height
    win.sizeKnown = ok
    if (win.desk) win.desk.box.size(ok, Date.now())
  }
  function uiFrame() {
    // A frame counts only if the size was already right before it (spec 3.3: the first frame after that).
    var before = win.sizeKnown
    uiSize()
    if (before && win.desk) win.desk.box.frame(Date.now())
  }
  function uiPointer() {
    if (!win.desk) return
    // The GLOBAL position of the pointer is reported, not the one inside the button. A button that moves under a pointer
    // that sat still changes the local position and leaves the global one alone, and only the model decides what is motion.
    var p = allowArea.mapToGlobal(allowArea.mouseX, allowArea.mouseY)
    win.desk.box.pointerAt(p.x, p.y, Date.now())
  }
  function uiPress(mouse) {
    if (!win.desk) return
    // Only a press that Qt or the system made out of a touch counts as a touch. Anything else, also a source that reads
    // undefined, is a mouse press, so the pointer-motion rule always applies to it.
    var s = mouse.source
    var touch = s === Qt.MouseEventSynthesizedByQt || s === Qt.MouseEventSynthesizedBySystem
    win.desk.box.press(touch ? "touch" : "mouse", Date.now())
  }
  // The model asks for this on every tick while the box has no counted frame: a box that does not change draws nothing, and
  // QQuickWindow.update() always schedules a frame.
  function requestFrame() {
    var w = scrim.qw
    if (w && typeof w.update === "function") w.update()
  }
  // The window is a new one on every show, so keyboard focus is forced onto the scrim, as Omarchy's own service windows do.
  function focusScrim() {
    Qt.callLater(function () { scrim.forceActiveFocus() })
  }
  function uiRelease(mouse) {
    if (!win.desk) return
    var inside = mouse.x >= 0 && mouse.y >= 0 && mouse.x <= allowArea.width && mouse.y <= allowArea.height
    win.desk.box.release(inside, Date.now())
  }

  onVisibleChanged: {
    if (!win.desk) return
    win.desk.box.visible(win.visible, Date.now())
    if (win.visible) {
      win.sizeKnown = false
      win.uiSize()
      win.focusScrim()
    }
  }
  onScreenChanged: {
    if (win.desk && win.visible) win.desk.box.screen(win.screen ? String(win.screen.name) : "", Date.now())
  }

  Rectangle {
    id: scrim
    anchors.fill: parent
    color: "#66000000"
    focus: true

    // The Qt window behind the PanelWindow: frameSwapped and active live there, not on PanelWindow itself.
    readonly property var qw: Window.window

    onWidthChanged: win.uiSize()
    onHeightChanged: win.uiSize()

    // Keys never approve. Esc is Deny, Enter only shows a hint, Tab moves to Deny, repeated keys are ignored.
    Keys.onPressed: function (event) {
      event.accepted = true
      if (!win.desk) return
      var name = "other"
      if (event.key === Qt.Key_Escape) name = "escape"
      else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) name = "enter"
      else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
        denyBtn.forceActiveFocus()
        return
      }
      win.desk.box.key(name, event.isAutoRepeat, Date.now())
    }

    Connections {
      target: scrim.qw
      ignoreUnknownSignals: true
      function onFrameSwapped() { win.uiFrame() }
      function onActiveChanged() {
        if (win.desk && scrim.qw) win.desk.box.active(!!scrim.qw.active, Date.now())
        if (scrim.qw && scrim.qw.active) win.focusScrim()
      }
    }

    Rectangle {
      id: card
      // The card hangs from a line that does not depend on its text, so the buttons at its foot keep their place whatever
      // changes above them (a tall plan only moves it up as far as the margin allows). Nothing in it changes size while
      // the box is open: the hint row and the footer have fixed room. So Allow never moves under a pointer that sat still.
      anchors.horizontalCenter: parent.horizontalCenter
      y: Math.max(24, Math.min(scrim.height / 2 + 140 - height, scrim.height - height - 24))
      width: Math.min(parent.width - 80, 680)
      height: col.implicitHeight + 48
      radius: 14
      color: "#1b1d23"
      border.color: "#4c566a"
      border.width: 1

      Column {
        id: col
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: 24 }
        spacing: 12

        Text {
          width: col.width
          text: win.content.title
          color: "#eceff4"
          font.pixelSize: 21
          font.bold: true
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          maximumLineCount: 3
          elide: Text.ElideRight
        }

        Repeater {
          model: win.content.lines
          delegate: Text {
            width: col.width
            text: modelData.text
            color: modelData.urgent ? win.urgentColor : "#eceff4"
            font.pixelSize: 17
            font.family: modelData.mono ? "monospace" : Qt.application.font.family
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }
        }

        Text {
          visible: win.content.note !== ""
          width: col.width
          text: win.content.note
          color: win.mutedColor
          font.pixelSize: 14
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          maximumLineCount: 3
          elide: Text.ElideRight
        }

        // Fixed room for three lines: the countdown wrapping the footer cannot push the buttons.
        Item {
          width: col.width
          height: 56
          Text {
            width: parent.width
            text: win.content.footer + (win.view.countdown > 0 ? " Auto-deny in " + win.view.countdown + " s." : "")
            color: win.mutedColor
            font.pixelSize: 14
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }
        }

        // The hint row always has its room, shown or not, so a hint cannot move the buttons either.
        Item {
          width: col.width
          height: 36
          Text {
            width: parent.width
            visible: win.view.hint !== ""
            text: win.view.hint
            color: "#ebcb8b"
            font.pixelSize: 14
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
          }
        }

        Row {
          spacing: 12

          // Deny: always available, no delay. Tab can focus it; Enter or Space on it means no.
          Rectangle {
            id: denyBtn
            width: 130
            height: 44
            radius: 8
            color: "#3b4252"
            border.width: activeFocus ? 2 : 0
            border.color: "#88c0d0"
            activeFocusOnTab: true
            Keys.onPressed: function (event) {
              if (event.isAutoRepeat) return
              if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || event.key === Qt.Key_Space) {
                event.accepted = true
                if (win.desk) win.desk.box.deny(Date.now())
              }
            }
            Text {
              anchors.centerIn: parent
              text: "Deny"
              color: "#eceff4"
              font.pixelSize: 17
              textFormat: Text.PlainText
            }
            MouseArea {
              anchors.fill: parent
              onClicked: { if (win.desk) win.desk.box.deny(Date.now()) }
            }
          }

          // Allow: a mouse or touch click only, and only after the delay. It never takes keyboard focus.
          Rectangle {
            id: allowBtn
            width: 130
            height: 44
            radius: 8
            color: win.view.allowReady ? "#a3be8c" : "#4c566a"
            activeFocusOnTab: false
            focusPolicy: Qt.NoFocus

            Rectangle {
              visible: !win.view.allowReady
              anchors.bottom: parent.bottom
              anchors.left: parent.left
              height: 4
              width: parent.width * win.view.progress
              color: "#88c0d0"
            }
            Text {
              anchors.centerIn: parent
              text: "Allow"
              color: win.view.allowReady ? "#1b1d23" : "#d8dee9"
              font.pixelSize: 17
              font.bold: true
              textFormat: Text.PlainText
            }
            MouseArea {
              id: allowArea
              anchors.fill: parent
              hoverEnabled: true
              focus: false
              acceptedButtons: Qt.LeftButton
              onEntered: win.uiPointer()
              onPositionChanged: win.uiPointer()
              onPressed: function (mouse) { win.uiPress(mouse) }
              onReleased: function (mouse) { win.uiRelease(mouse) }
            }
          }

          // Optional third control: a no that also pauses all requests for an hour. A no needs no delay.
          Rectangle {
            id: pauseBtn
            width: 210
            height: 44
            radius: 8
            color: "transparent"
            border.width: 1
            border.color: "#4c566a"
            activeFocusOnTab: false
            Text {
              anchors.centerIn: parent
              text: "Deny and pause 1 hour"
              color: win.mutedColor
              font.pixelSize: 14
              textFormat: Text.PlainText
            }
            MouseArea {
              anchors.fill: parent
              onClicked: { if (win.desk) win.desk.box.denyPause(Date.now()) }
            }
          }
        }
      }
    }
  }
}
