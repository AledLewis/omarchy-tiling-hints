import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import "HintsModel.js" as Model

// Tiling hints: while Super is held, draw the keys that act on each window
// in and around its frame. Driven by a Hyprland hold bind:
//
//   o.bind_hold("SUPER + Super_L", "Show tiling hints", "omarchy-shell -q tiling-hints show",
//               "Hide tiling hints", "omarchy-shell -q tiling-hints hide",
//               { ignore_mods = true, non_consuming = true })
//
// The overlay is visual only: its input region is empty and it never takes
// keyboard focus, so every Super chord and Super+drag still reaches Hyprland.
Scope {
  id: root

  // Injected by the shell host.
  property var shell: null
  property var manifest: null
  property string omarchyPath: ""

  // Wait this long after Super goes down before drawing, so quick chords
  // such as Super+Enter never flash the overlay.
  property int showDelay: 260
  // A hold bind can miss its release (a VT switch, a lock screen taking the
  // keyboard). Never leave the overlay stuck for longer than this.
  property int maxHold: 30000

  property bool held: false
  property bool opened: false

  // Bind descriptions -> keycaps, from Omarchy's keybindings list.
  property var binds: ({})

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  function show() {
    if (held) return
    held = true
    Hyprland.refreshToplevels()
    Hyprland.refreshMonitors()
    showTimer.restart()
    stuckTimer.restart()
  }

  function hide() {
    held = false
    opened = false
    showTimer.stop()
    stuckTimer.stop()
  }

  Timer {
    id: showTimer
    interval: root.showDelay
    onTriggered: if (root.held) root.opened = true
  }

  Timer {
    id: stuckTimer
    interval: root.maxHold
    onTriggered: root.hide()
  }

  // Windows move under the overlay while Super is held (Super+Shift+arrow
  // swaps, Super+arrow refocuses): follow along.
  Timer {
    id: refreshDebounce
    interval: 40
    onTriggered: { Hyprland.refreshToplevels(); Hyprland.refreshMonitors() }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      var name = event ? String(event.name) : ""
      if (name === "configreloaded") bindsProc.running = true
      if (root.held) refreshDebounce.restart()
    }
  }

  Process {
    id: bindsProc
    command: ["omarchy-menu-keybindings", "--print"]
    stdout: StdioCollector {
      onStreamFinished: root.binds = Model.parsePrinted(this.text)
    }
  }

  Component.onCompleted: bindsProc.running = true

  ShellIpc {
    target: "tiling-hints"
    function show(): string { root.show(); return "ok" }
    function hide(): string { root.hide(); return "ok" }
    function toggle(): string { if (root.held) root.hide(); else root.show(); return "ok" }
    function state(): string { return root.opened ? "open" : (root.held ? "pending" : "closed") }
    function ping(): string { return "ok" }
  }

  // ------------------------------------------------------------ hint sets

  readonly property var dirWords: ({ l: "left", r: "right", u: "up", d: "down" })

  function edgeHints(dir) {
    var focus = { l: "Focus on left window", r: "Focus on right window", u: "Focus on above window", d: "Focus on below window" }
    var swap = { l: "Swap window to the left", r: "Swap window to the right", u: "Swap window up", d: "Swap window down" }
    var group = { l: "Move window to group on left", r: "Move window to group on right", u: "Move window to group on top", d: "Move window to group on bottom" }
    return Model.resolve([
      { desc: focus[dir], label: strings.t("edge.focus") },
      { desc: swap[dir], label: strings.t("edge.swap") },
      { desc: group[dir], label: strings.t("edge.group") }
    ], binds)
  }

  function monitorHints(dir) {
    var win = { l: "Move window to left monitor", r: "Move window to right monitor", u: "Move window to up monitor", d: "Move window to down monitor" }
    var ws = { l: "Move workspace to left monitor", r: "Move workspace to right monitor", u: "Move workspace to up monitor", d: "Move workspace to down monitor" }
    return Model.resolve([
      { desc: win[dir], label: strings.t("edge.windowToMonitor") },
      { desc: ws[dir], label: strings.t("edge.workspaceToMonitor") }
    ], binds)
  }

  function windowHints(win, compact) {
    var all = [
      { desc: "Close window", label: strings.t("action.close") },
      { desc: "Toggle window floating/tiling", label: win.floating ? strings.t("action.tile") : strings.t("action.float") },
      { desc: "Full screen", label: strings.t("action.fullscreen") },
      { desc: "Toggle window split", label: strings.t("action.split"), tiledOnly: true },
      { desc: "Tiled full screen", label: strings.t("action.tiledFullscreen"), full: true },
      { desc: "Full width", label: strings.t("action.fullWidth"), full: true },
      { desc: "Pseudo window", label: strings.t("action.pseudo"), tiledOnly: true, full: true },
      { desc: "Pop window out (float & pin)", label: strings.t("action.pop") },
      { desc: "Toggle window grouping", label: win.groupSize ? strings.t("action.ungroupAll") : strings.t("action.group") },
      { desc: "Minimize window to the dock", label: strings.t("action.minimize"), full: true },
      { desc: "Move window to scratchpad", label: strings.t("action.toScratchpad"), full: true },
      { desc: "Toggle transparency on a window", label: strings.t("action.transparency"), full: true }
    ]
    var picked = all.filter(function(h) {
      if (h.tiledOnly && win.floating) return false
      if (compact && h.full) return false
      return true
    })
    return Model.resolve(picked, binds)
  }

  function resizeHints() {
    return Model.resolve([
      { desc: "Expand window left", label: strings.t("resize.narrower") },
      { desc: "Shrink window left", label: strings.t("resize.wider") },
      { desc: "Shrink window up", label: strings.t("resize.shorter") },
      { desc: "Expand window down", label: strings.t("resize.taller") }
    ], binds)
  }

  function groupHints() {
    var out = Model.resolve([
      { desc: "Next window in group", label: strings.t("group.next") },
      { desc: "Move active window out of group", label: strings.t("group.leave") }
    ], binds)
    var pick = Model.rangeHint(binds, "Switch to group window 1", "Switch to group window 5", strings.t("group.pick"))
    if (pick) out.push(pick)
    return out
  }

  function stripHints() {
    var out = []
    var ws = Model.rangeHint(binds, "Switch to workspace 1", "Switch to workspace 10", strings.t("strip.workspace"))
    if (ws) out.push(ws)
    var send = Model.rangeHint(binds, "Move window to workspace 1", "Move window to workspace 10", strings.t("strip.sendWindow"))
    if (send) out.push(send)
    return out.concat(Model.resolve([
      { desc: "Next workspace", label: strings.t("strip.nextWorkspace") },
      { desc: "Former workspace", label: strings.t("strip.formerWorkspace") },
      { desc: "Toggle scratchpad", label: strings.t("strip.scratchpad") },
      { desc: "Cycle workspace layout", label: strings.t("strip.layout") },
      { desc: "Move window", label: strings.t("strip.dragMove") },
      { desc: "Resize window", label: strings.t("strip.dragResize") },
      { desc: "Keybindings", label: strings.t("strip.allKeys") }
    ], binds))
  }

  function emptyHints() {
    return Model.resolve([
      { desc: "Terminal", label: strings.t("empty.terminal") },
      { desc: "Omarchy menu", label: strings.t("empty.menu") },
      { desc: "Toggle scratchpad", label: strings.t("strip.scratchpad") }
    ], binds)
  }

  // ------------------------------------------------------------ pieces

  component PlainText: Text {
    textFormat: Text.PlainText
    color: Color.popups.text
    font.family: Style.font.family
    font.pixelSize: Style.font.body
  }

  component Keycap: Rectangle {
    property string label: ""
    property bool strong: false
    implicitWidth: Math.max(capText.implicitWidth + Style.spacing.md * 2, implicitHeight)
    implicitHeight: capText.implicitHeight + Style.spacing.xs * 2
    radius: Math.min(Style.cornerRadius, Style.spacing.sm)
    color: strong ? Color.accent : Qt.alpha(Color.foreground, 0.12)
    border.width: Style.normalBorderWidth
    border.color: strong ? Color.accent : Qt.alpha(Color.foreground, 0.35)
    PlainText {
      id: capText
      anchors.centerIn: parent
      text: parent.label
      font.bold: true
      font.pixelSize: Style.font.bodySmall
      color: parent.strong ? Color.background : Color.popups.text
    }
  }

  // One hint: its keycaps, then what it does.
  component HintRow: Row {
    property var hint: ({ keys: [], label: "" })
    spacing: Style.spacing.sm
    Row {
      spacing: Style.spacing.xxs
      anchors.verticalCenter: parent.verticalCenter
      Repeater {
        model: hint.keys
        delegate: Keycap { required property var modelData; label: modelData }
      }
    }
    PlainText {
      anchors.verticalCenter: parent.verticalCenter
      text: hint.label
      opacity: 0.85
    }
  }

  component Card: Rectangle {
    default property alias content: inner.data
    property int pad: Style.spacing.lg
    implicitWidth: inner.implicitWidth + pad * 2
    implicitHeight: inner.implicitHeight + pad * 2
    width: implicitWidth
    height: implicitHeight
    radius: Style.cornerRadius
    color: Color.popups.background
    border.width: Math.max(1, Style.normalBorderWidth)
    border.color: Color.popups.border
    Column {
      id: inner
      x: parent.pad
      y: parent.pad
      spacing: Style.spacing.sm
    }
  }

  // A card of hints pinned just inside one edge of a window.
  component EdgeCard: Card {
    property string dir: "l"
    property var hints: []
    property var box: ({ w: 0, h: 0 })
    property int inset: Style.spacing.xl
    visible: hints.length > 0
    x: dir === "l" ? inset
      : dir === "r" ? box.w - width - inset
      : (box.w - width) / 2
    y: dir === "u" ? inset
      : dir === "d" ? box.h - height - inset
      : (box.h - height) / 2
    Repeater {
      model: hints
      delegate: HintRow { required property var modelData; hint: modelData }
    }
  }

  // ------------------------------------------------------------ surfaces

  Variants {
    model: Quickshell.screens

    delegate: Component {
      PanelWindow {
        id: win

        required property var modelData
        screen: modelData

        readonly property var monitor: Hyprland.monitorFor(modelData)
        readonly property var monitorIpc: monitor ? monitor.lastIpcObject : null
        readonly property bool focused: !!monitor && Hyprland.focusedMonitor === monitor

        // The workspace on screen: an open special workspace sits on top of
        // the regular one and is what Super chords act on.
        readonly property int workspaceId: {
          var special = monitorIpc && monitorIpc.specialWorkspace ? Number(monitorIpc.specialWorkspace.id || 0) : 0
          if (special !== 0) return special
          return monitor && monitor.activeWorkspace ? monitor.activeWorkspace.id : -1
        }

        function logicalRect(ipc) {
          var scale = Number(ipc.scale || 1) || 1
          var rotated = Number(ipc.transform || 0) % 2 === 1
          var w = Number(ipc.width || 0) / scale, h = Number(ipc.height || 0) / scale
          return { x: Number(ipc.x || 0), y: Number(ipc.y || 0), w: rotated ? h : w, h: rotated ? w : h }
        }

        readonly property var layout: {
          if (!root.opened || !monitor) return []
          var active = Hyprland.activeToplevel
          var activeAddress = active ? "0x" + String(active.address).replace(/^0x/, "") : ""
          var mx = monitorIpc ? Number(monitorIpc.x || 0) : 0
          var my = monitorIpc ? Number(monitorIpc.y || 0) : 0
          var windows = []
          var toplevels = Hyprland.toplevels.values
          for (var i = 0; i < toplevels.length; i++) {
            var ipc = toplevels[i].lastIpcObject
            if (!ipc || !ipc.workspace || Number(ipc.workspace.id) !== workspaceId) continue
            var w = Model.normalizeClient(ipc, mx, my, activeAddress)
            if (w) windows.push(w)
          }
          var monitors = []
          var all = Hyprland.monitors.values
          for (var j = 0; j < all.length; j++) if (all[j].lastIpcObject) monitors.push(logicalRect(all[j].lastIpcObject))
          return Model.build(windows, monitorIpc ? logicalRect(monitorIpc) : null, monitors)
        }

        readonly property var reserved: monitorIpc && monitorIpc.reserved ? monitorIpc.reserved : [0, 0, 0, 0]

        visible: root.opened && !!monitor
        color: "transparent"
        exclusionMode: ExclusionMode.Ignore
        anchors { top: true; left: true; bottom: true; right: true }
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        WlrLayershell.namespace: "omarchy-tiling-hints"
        // Visual only: never take a click or a Super+drag.
        mask: Region {}

        Repeater {
          model: win.layout

          delegate: Item {
            id: frame
            required property var modelData
            readonly property var w: modelData
            readonly property bool compact: w.w < 520 || w.h < 380

            x: w.x
            y: w.y
            width: w.w
            height: w.h

            // Frame wash and border: the active window in the accent, the rest muted.
            Rectangle {
              anchors.fill: parent
              radius: Style.cornerRadius
              color: Qt.alpha(Color.background, frame.w.active ? 0.30 : 0.55)
              border.width: frame.w.active ? 3 : 2
              border.color: frame.w.active ? Color.accent : Qt.alpha(Color.muted, 0.9)
            }

            // ---- active window: actions in the middle, edges on the edges
            Card {
              visible: frame.w.active
              anchors.centerIn: parent
              PlainText {
                text: (frame.w.appClass.length > 28 ? frame.w.appClass.slice(0, 27) + "…" : frame.w.appClass) + "  ·  " + (frame.w.fullscreen ? strings.t("state.fullscreen")
                  : frame.w.floating ? strings.t("state.floating")
                  : frame.w.groupSize ? strings.t("state.grouped").arg(frame.w.groupSize)
                  : strings.t("state.tiled"))
                font.bold: true
                font.pixelSize: Style.font.title
                color: Color.accent
              }
              Grid {
                columns: frame.compact ? 1 : 2
                columnSpacing: Style.spacing.huge
                rowSpacing: Style.spacing.sm
                Repeater {
                  model: frame.w.active ? root.windowHints(frame.w, frame.compact) : []
                  delegate: HintRow { required property var modelData; hint: modelData }
                }
              }
            }

            Repeater {
              model: frame.w.active && !frame.w.fullscreen ? ["l", "r", "u", "d"] : []
              delegate: EdgeCard {
                required property var modelData
                dir: modelData
                box: frame.w
                hints: frame.w.neighbors[modelData] ? root.edgeHints(modelData)
                  : frame.w.monitorToward[modelData] ? root.monitorHints(modelData)
                  : []
              }
            }

            // Resize keys hug the bottom-right corner, where the size changes.
            Card {
              visible: frame.w.active && !frame.w.floating && !frame.w.fullscreen && !frame.compact
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              anchors.rightMargin: Style.spacing.xl
              anchors.bottomMargin: Style.spacing.xl
                + (win.focused && frame.y + frame.height > win.height - win.stripClearance ? win.stripClearance : 0)
              pad: Style.spacing.md
              PlainText { text: strings.t("resize.title"); opacity: 0.7; font.pixelSize: Style.font.caption }
              Repeater {
                model: frame.w.active ? root.resizeHints() : []
                delegate: HintRow { required property var modelData; hint: modelData }
              }
            }

            // Tabbed group controls sit along the top, where the tabs are.
            Card {
              visible: frame.w.active && frame.w.groupSize > 0
              anchors.left: parent.left
              anchors.top: parent.top
              anchors.margins: Style.spacing.xl
              pad: Style.spacing.md
              Repeater {
                model: frame.w.active && frame.w.groupSize > 0 ? root.groupHints() : []
                delegate: HintRow { required property var modelData; hint: modelData }
              }
            }

            // ---- neighbours: the arrow that reaches them from the active window
            Column {
              visible: frame.w.fromActive !== ""
              anchors.centerIn: parent
              spacing: Style.spacing.md
              PlainText {
                anchors.horizontalCenter: parent.horizontalCenter
                text: Model.arrow(frame.w.fromActive)
                font.pixelSize: Math.min(96, Math.max(Style.font.displayLarge, Math.min(frame.width, frame.height) / 5))
                font.bold: true
                color: Color.accent
              }
              Card {
                anchors.horizontalCenter: parent.horizontalCenter
                Repeater {
                  model: frame.w.fromActive ? root.edgeHints(frame.w.fromActive).slice(0, 2) : []
                  delegate: HintRow { required property var modelData; hint: modelData }
                }
              }
            }

            // Windows that are neither active nor next to it just get named.
            PlainText {
              visible: !frame.w.active && frame.w.fromActive === ""
              anchors.centerIn: parent
              text: frame.w.appClass
              opacity: 0.7
              font.pixelSize: Style.font.heading
            }
          }
        }

        // Empty workspace: what to open.
        Card {
          visible: win.focused && win.layout.length === 0
          anchors.centerIn: parent
          PlainText {
            text: strings.t("empty.title")
            font.bold: true
            font.pixelSize: Style.font.title
            color: Color.accent
          }
          Repeater {
            model: win.focused ? root.emptyHints() : []
            delegate: HintRow { required property var modelData; hint: modelData }
          }
        }

        // Room the workspace strip takes from the bottom of the screen.
        readonly property int stripClearance: strip.height + Number(win.reserved[3] || 0) + Style.spacing.huge * 2

        // Workspace keys along the bottom of the focused monitor.
        Card {
          id: strip
          visible: win.focused
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.bottom: parent.bottom
          anchors.bottomMargin: Number(win.reserved[3] || 0) + Style.spacing.huge
          pad: Style.spacing.md
          Row {
            spacing: Style.spacing.huge
            Repeater {
              model: win.focused ? root.stripHints() : []
              delegate: HintRow { required property var modelData; hint: modelData }
            }
          }
        }
      }
    }
  }
}
