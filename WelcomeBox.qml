import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons as Commons

// The one-time welcome note (spec 3.9). It looks different from the Allow box on purpose: no scrim, no Allow, no Deny.
// It never runs the connect command and never edits any agent's settings. Copy only puts the text on the clipboard.
// It wears the shell's theme, as the Allow box does.
PanelWindow {
  id: win

  property string serverPath: ""
  readonly property string command: serverPath === "" ? "" : "claude mcp add --scope user omacommand -- /usr/bin/ruby --disable=gems,rubyopt " + serverPath

  signal copyRequested(string command)
  signal closeRequested()

  // ---- the look: tokens of the shell's theme (qs.Commons), each with a fallback for a shell that lacks it
  function pick(v, d) { return (v !== undefined && v !== null && String(v) !== "") ? v : d }
  function token(read, d) {
    try { return win.pick(read(), d) } catch (e) { return d }
  }
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }
  readonly property color fg: pick(Commons.Color.foreground, "#cacccc")
  readonly property color bg: pick(Commons.Color.background, "#101315")
  readonly property color accentColor: pick(Commons.Color.accent, "#cacccc")
  readonly property color softColor: alpha(fg, 0.6)
  readonly property string fontFamily: token(function () { return Commons.Style.font.family }, "monospace")
  readonly property int lineSize: token(function () { return Commons.Style.font.title }, 14)
  readonly property int smallSize: token(function () { return Commons.Style.font.body }, 12)
  readonly property int pad: token(function () { return Commons.Style.spacing.panelPadding }, 18)
  readonly property int gap: token(function () { return Commons.Style.spacing.xl }, 10)
  readonly property int cornerRadius: token(function () { return Commons.Style.cornerRadius }, 0)
  readonly property int lineWidth: token(function () { return Commons.Style.normalBorderWidth }, 1)
  readonly property int frameWidth: token(function () { return Math.max(2, Commons.Style.space(2)) }, 2)
  readonly property int buttonWidth: token(function () { return Commons.Style.space(96) }, 96)
  readonly property int buttonHeight: token(function () { return Commons.Style.space(34) }, 34)

  visible: false
  color: "transparent"
  implicitWidth: token(function () { return Commons.Style.space(640) }, 640)
  implicitHeight: card.height
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.layer: WlrLayer.Overlay
  // OnDemand: someone who is still typing in a terminal keeps the keyboard.
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand
  WlrLayershell.namespace: "omacommand-welcome"

  Rectangle {
    id: card
    width: win.implicitWidth
    height: col.implicitHeight + win.pad * 2
    radius: win.cornerRadius
    color: win.bg
    border.color: win.accentColor
    border.width: win.frameWidth
    focus: true

    Keys.onPressed: function (event) {
      if (event.key === Qt.Key_Escape && !event.isAutoRepeat) {
        event.accepted = true
        win.closeRequested()
      }
    }

    Column {
      id: col
      anchors { left: parent.left; right: parent.right; top: parent.top; margins: win.pad }
      spacing: win.gap

      Text {
        width: col.width
        text: "Omacommand is on. Step 2: connect your agent. For Claude Code, run this once in a terminal:"
        color: win.fg
        font.family: win.fontFamily
        font.pixelSize: win.lineSize
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        maximumLineCount: 4
        elide: Text.ElideRight
      }

      Rectangle {
        width: col.width
        height: cmd.implicitHeight + win.gap * 2
        color: win.alpha(win.fg, 0.04)
        border.width: win.lineWidth
        border.color: win.alpha(win.fg, 0.2)
        Text {
          id: cmd
          anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: win.gap }
          text: win.command === "" ? "(The command is in the README.)" : win.command
          color: win.accentColor
          font.family: "monospace"
          font.pixelSize: win.smallSize
          textFormat: Text.PlainText
          wrapMode: Text.WrapAnywhere
          maximumLineCount: 8
          elide: Text.ElideRight
        }
      }

      Row {
        spacing: win.gap

        Rectangle {
          width: win.buttonWidth
          height: win.buttonHeight
          color: win.command === "" ? "transparent" : win.alpha(win.accentColor, copyArea.containsMouse ? 0.3 : 0.18)
          border.width: win.command === "" ? win.lineWidth : win.frameWidth
          border.color: win.command === "" ? win.alpha(win.fg, 0.2) : win.accentColor
          Text {
            anchors.centerIn: parent
            text: "Copy"
            color: win.command === "" ? win.alpha(win.fg, 0.38) : win.accentColor
            font.family: win.fontFamily
            font.pixelSize: win.lineSize
            font.bold: true
            textFormat: Text.PlainText
          }
          MouseArea {
            id: copyArea
            anchors.fill: parent
            enabled: win.command !== ""
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: win.copyRequested(win.command)
          }
        }

        Rectangle {
          width: win.buttonWidth
          height: win.buttonHeight
          color: closeArea.containsMouse ? win.alpha(win.fg, 0.08) : "transparent"
          border.width: win.lineWidth
          border.color: win.alpha(win.fg, 0.38)
          Text {
            anchors.centerIn: parent
            text: "Close"
            color: win.fg
            font.family: win.fontFamily
            font.pixelSize: win.lineSize
            textFormat: Text.PlainText
          }
          MouseArea {
            id: closeArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: win.closeRequested()
          }
        }
      }

      Text {
        width: col.width
        text: "Other agents: see the README."
        color: win.softColor
        font.family: win.fontFamily
        font.pixelSize: win.smallSize
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
      }
    }
  }
}
