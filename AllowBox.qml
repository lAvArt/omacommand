import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Wayland
import qs.Commons as Commons

// The Allow box (spec 3). A PanelWindow on the Overlay layer that the service owns, like the windows of Omarchy's own services.
// The rules (delay, click checks, timeout) are in box_model.js; this file only reports events and draws what the model says.
// It wears the shell's theme as Omarchy's own dialogs do: the theme's colours, its monospace font and type scale, square
// buttons with thin borders, Hyprland's corner rounding, and the accent on the card's frame and on Allow once it is ready.
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

  // ---- the look: tokens of the shell's theme (qs.Commons), each with a fallback for a shell that lacks it
  function pick(v, d) { return (v !== undefined && v !== null && String(v) !== "") ? v : d }
  function token(read, d) {
    try { return win.pick(read(), d) } catch (e) { return d }
  }
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
  readonly property color fg: pick(Commons.Color.foreground, "#cacccc")
  readonly property color bg: pick(Commons.Color.background, "#101315")
  readonly property color accentColor: pick(Commons.Color.accent, "#cacccc")
  readonly property color urgentColor: pick(Commons.Color.urgent, "#a55555")
  // Secondary text is the foreground at less strength, as on Omarchy's own surfaces. The theme's "muted" cannot carry text:
  // in some themes it is a surface colour (#333333 on a #121212 card).
  readonly property color softColor: alpha(fg, 0.6)
  readonly property string fontFamily: token(function () { return Commons.Style.font.family }, "monospace")
  readonly property int titleSize: token(function () { return Commons.Style.font.heading }, 16)
  readonly property int lineSize: token(function () { return Commons.Style.font.title }, 14)
  readonly property int smallSize: token(function () { return Commons.Style.font.body }, 12)
  readonly property int pad: token(function () { return Commons.Style.spacing.panelPadding }, 18)
  readonly property int gap: token(function () { return Commons.Style.spacing.xl }, 10)
  readonly property int cornerRadius: token(function () { return Commons.Style.cornerRadius }, 0)
  readonly property int lineWidth: token(function () { return Commons.Style.normalBorderWidth }, 1)
  readonly property int frameWidth: token(function () { return Math.max(2, Commons.Style.space(2)) }, 2)
  readonly property int buttonWidth: token(function () { return Commons.Style.space(96) }, 96)
  readonly property int buttonHeight: token(function () { return Commons.Style.space(34) }, 34)
  readonly property int cardWidth: token(function () { return Commons.Style.space(680) }, 680)
  // The longest hint box_model.js can show (its HINT_ texts) and the longest countdown (10 s): the footer and the hint row
  // get the room these need, measured when the box opens, so neither can move the buttons while it is open.
  readonly property string longestHint: "Move the pointer over Allow, then click."
  readonly property string longestCountdown: " Auto-deny in 10 s."

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
    color: win.alpha(win.bg, 0.4)
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
      width: Math.min(parent.width - 80, win.cardWidth)
      height: col.implicitHeight + win.pad * 2
      radius: win.cornerRadius
      color: win.bg
      border.color: win.accentColor
      border.width: win.frameWidth

      Column {
        id: col
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: win.pad }
        spacing: win.gap

        Text {
          width: col.width
          text: win.content.title
          color: win.fg
          font.family: win.fontFamily
          font.pixelSize: win.titleSize
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
            color: modelData.urgent ? win.urgentColor : win.fg
            font.pixelSize: win.lineSize
            font.family: modelData.mono ? "monospace" : win.fontFamily
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
          color: win.softColor
          font.family: win.fontFamily
          font.pixelSize: win.smallSize
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          maximumLineCount: 3
          elide: Text.ElideRight
        }

        Rectangle {
          width: col.width
          height: win.lineWidth
          color: win.alpha(win.fg, 0.12)
        }

        // Fixed room: the footer with the longest countdown, measured by a hidden twin. The countdown cannot push the buttons.
        Item {
          width: col.width
          height: footerRoom.implicitHeight
          Text {
            id: footerRoom
            visible: false
            width: parent.width
            text: win.content.footer + win.longestCountdown
            font.family: win.fontFamily
            font.pixelSize: win.smallSize
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }
          Text {
            width: parent.width
            text: win.content.footer + (win.view.countdown > 0 ? " Auto-deny in " + win.view.countdown + " s." : "")
            color: win.softColor
            font.family: win.fontFamily
            font.pixelSize: win.smallSize
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }
        }

        // The hint row always has the room of the longest hint, shown or not, so a hint cannot move the buttons either.
        Item {
          width: col.width
          height: hintRoom.implicitHeight
          Text {
            id: hintRoom
            visible: false
            width: parent.width
            text: win.longestHint
            font.family: win.fontFamily
            font.pixelSize: win.smallSize
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
          }
          Text {
            width: parent.width
            visible: win.view.hint !== ""
            text: win.view.hint
            color: win.accentColor
            font.family: win.fontFamily
            font.pixelSize: win.smallSize
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
          }
        }

        // The buttons sit at the foot of the card: the quiet one on the left, Deny and then Allow on the right, where
        // Omarchy's own dialogs put their confirm button. Their size depends on the theme only, never on the text above.
        Item {
          width: col.width
          height: win.buttonHeight

          // Optional third control: a no that also pauses all requests for an hour. A no needs no delay.
          Rectangle {
            id: pauseBtn
            anchors.left: parent.left
            width: pauseLabel.implicitWidth + win.pad * 2
            height: parent.height
            color: pauseArea.containsMouse ? win.alpha(win.fg, 0.08) : "transparent"
            border.width: win.lineWidth
            border.color: win.alpha(win.fg, 0.2)
            activeFocusOnTab: false
            Text {
              id: pauseLabel
              anchors.centerIn: parent
              text: "Deny and pause 1 hour"
              color: win.softColor
              font.family: win.fontFamily
              font.pixelSize: win.smallSize
              textFormat: Text.PlainText
            }
            MouseArea {
              id: pauseArea
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: { if (win.desk) win.desk.box.denyPause(Date.now()) }
            }
          }

          Row {
            anchors.right: parent.right
            spacing: win.gap

            // Deny: always available, no delay. Tab can focus it; Enter or Space on it means no.
            Rectangle {
              id: denyBtn
              width: win.buttonWidth
              height: win.buttonHeight
              color: denyBtn.activeFocus || denyArea.containsMouse ? win.alpha(win.fg, 0.08) : "transparent"
              border.width: denyBtn.activeFocus ? win.frameWidth : win.lineWidth
              border.color: denyBtn.activeFocus ? win.accentColor : win.alpha(win.fg, 0.38)
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
                color: denyBtn.activeFocus ? win.accentColor : win.fg
                font.family: win.fontFamily
                font.pixelSize: win.lineSize
                textFormat: Text.PlainText
              }
              MouseArea {
                id: denyArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: { if (win.desk) win.desk.box.deny(Date.now()) }
              }
            }

            // Allow: a mouse or touch click only, and only after the delay. It never takes keyboard focus. Until it is ready
            // it is greyed, with a line that fills along its foot (spec 3.3); then it takes the theme's accent.
            Rectangle {
              id: allowBtn
              width: win.buttonWidth
              height: win.buttonHeight
              color: win.view.allowReady ? win.alpha(win.accentColor, allowArea.containsMouse ? 0.3 : 0.18) : "transparent"
              border.width: win.view.allowReady ? win.frameWidth : win.lineWidth
              border.color: win.view.allowReady ? win.accentColor : win.alpha(win.fg, 0.2)
              activeFocusOnTab: false
              focusPolicy: Qt.NoFocus

              Rectangle {
                visible: !win.view.allowReady
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                height: win.frameWidth
                width: parent.width * win.view.progress
                color: win.accentColor
              }
              Text {
                anchors.centerIn: parent
                text: "Allow"
                color: win.view.allowReady ? win.accentColor : win.alpha(win.fg, 0.38)
                font.family: win.fontFamily
                font.pixelSize: win.lineSize
                font.bold: true
                textFormat: Text.PlainText
              }
              MouseArea {
                id: allowArea
                anchors.fill: parent
                hoverEnabled: true
                focus: false
                cursorShape: Qt.PointingHandCursor
                acceptedButtons: Qt.LeftButton
                onEntered: win.uiPointer()
                onPositionChanged: win.uiPointer()
                onPressed: function (mouse) { win.uiPress(mouse) }
                onReleased: function (mouse) { win.uiRelease(mouse) }
              }
            }
          }
        }
      }
    }
  }
}
