import QtQuick
import Quickshell
import Quickshell.Wayland

// The one-time welcome note (spec 3.9). It looks different from the Allow box on purpose: no scrim, no Allow, no Deny.
// It never runs the connect command and never edits any agent's settings. Copy only puts the text on the clipboard.
PanelWindow {
  id: win

  property string serverPath: ""
  readonly property string command: serverPath === "" ? "" : "claude mcp add --scope user omacommand -- /usr/bin/ruby --disable=gems,rubyopt " + serverPath

  signal copyRequested(string command)
  signal closeRequested()

  visible: false
  color: "transparent"
  implicitWidth: 640
  implicitHeight: card.height
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.layer: WlrLayer.Overlay
  // OnDemand: someone who is still typing in a terminal keeps the keyboard.
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand
  WlrLayershell.namespace: "omacommand-welcome"

  Rectangle {
    id: card
    width: win.implicitWidth
    height: col.implicitHeight + 48
    radius: 14
    color: "#1b1d23"
    border.color: "#88c0d0"
    border.width: 2
    focus: true

    Keys.onPressed: function (event) {
      if (event.key === Qt.Key_Escape && !event.isAutoRepeat) {
        event.accepted = true
        win.closeRequested()
      }
    }

    Column {
      id: col
      anchors { left: parent.left; right: parent.right; top: parent.top; margins: 24 }
      spacing: 14

      Text {
        width: col.width
        text: "Omacommand is on. Step 2: connect your agent. For Claude Code, run this once in a terminal:"
        color: "#eceff4"
        font.pixelSize: 17
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        maximumLineCount: 4
        elide: Text.ElideRight
      }

      Rectangle {
        width: col.width
        height: cmd.implicitHeight + 24
        radius: 8
        color: "#11131a"
        Text {
          id: cmd
          anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: 12 }
          text: win.command === "" ? "(The command is in the README.)" : win.command
          color: "#a3be8c"
          font.family: "monospace"
          font.pixelSize: 14
          textFormat: Text.PlainText
          wrapMode: Text.WrapAnywhere
          maximumLineCount: 8
          elide: Text.ElideRight
        }
      }

      Row {
        spacing: 12

        Rectangle {
          width: 130
          height: 40
          radius: 8
          color: win.command === "" ? "#3b4252" : "#88c0d0"
          Text {
            anchors.centerIn: parent
            text: "Copy"
            color: "#1b1d23"
            font.pixelSize: 16
            font.bold: true
            textFormat: Text.PlainText
          }
          MouseArea {
            anchors.fill: parent
            enabled: win.command !== ""
            onClicked: win.copyRequested(win.command)
          }
        }

        Rectangle {
          width: 130
          height: 40
          radius: 8
          color: "#3b4252"
          Text {
            anchors.centerIn: parent
            text: "Close"
            color: "#eceff4"
            font.pixelSize: 16
            textFormat: Text.PlainText
          }
          MouseArea {
            anchors.fill: parent
            onClicked: win.closeRequested()
          }
        }
      }

      Text {
        width: col.width
        text: "Other agents: see the README."
        color: "#9aa3b5"
        font.pixelSize: 14
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
      }
    }
  }
}
