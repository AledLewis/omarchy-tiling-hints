import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import "HintsModel.js" as Model

// Tiling hints: while Super is held, draw the keys that act on each window
// in and around its frame. Driven by a Hyprland hold bind on Super_L, which
// the service adds itself at runtime (see "hold bind" below).
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
  // Bind the Super hold in Hyprland while the plugin runs. Off: bind it yourself.
  property bool autoBind: true

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

  // Some layout changes emit no Hyprland event at all (Super+J's togglesplit),
  // so poll window geometry while the overlay is up. One IPC request per tick,
  // and the frames only rebuild when something actually moved.
  Timer {
    interval: 50
    repeat: true
    running: root.opened
    onTriggered: Hyprland.refreshToplevels()
  }

  // How Hyprland picks between several windows on one side of the active one:
  // 0 most recently focused, 1 longest shared edge.
  property int focusMethod: 0

  Process {
    id: focusMethodProc
    command: ["hyprctl", "getoption", "binds:focus_preferred_method", "-j"]
    stdout: StdioCollector {
      onStreamFinished: {
        try { root.focusMethod = Number(JSON.parse(this.text).int) || 0 } catch (e) { root.focusMethod = 0 }
      }
    }
  }

  // Hyprland's own window-move animation, so frames slide with their windows.
  property var moveAnimation: ({ duration: 0, bezier: [0.23, 1, 0.32, 1] })

  Process {
    id: animationsProc
    command: ["hyprctl", "animations", "-j"]
    stdout: StdioCollector {
      onStreamFinished: root.moveAnimation = Model.windowMoveAnimation(this.text)
    }
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      var name = event ? String(event.name) : ""
      if (name === "configreloaded") { root.boundHere = false; root.ensureBind(); bindsProc.running = true; animationsProc.running = true; focusMethodProc.running = true }
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

  // ------------------------------------------------------------ hold bind
  //
  // The plugin binds the Super hold itself while it runs, through Hyprland's
  // Lua eval (no config file is touched). It keeps the two bind handles and
  // only ever enables or disables those, so a user's own binds on Super_L are
  // never touched (see HintsModel.js for why nothing is unbound). A config
  // reload drops runtime binds, so they are added again after each one. A
  // hold bind already present, such as one written in bindings.lua by hand,
  // is left alone and none is added.
  property bool boundHere: false

  readonly property string holdKeys: "SUPER + Super_L"

  function ensureBind() {
    if (autoBind && !reuseBindProc.running && !existingBindProc.running) reuseBindProc.running = true
  }

  // 1. Handles left by a previous shell (restart without a reload): enable them.
  Process {
    id: reuseBindProc
    command: ["hyprctl", "eval", Model.holdReuseLua()]
    stdout: StdioCollector {
      onStreamFinished: {
        if (Model.reusedHold(this.text)) { root.boundHere = true; bindsProc.running = true; return }
        existingBindProc.running = true
      }
    }
  }

  // 2. Otherwise add the bind, unless one with its description exists already.
  Process {
    id: existingBindProc
    command: ["hyprctl", "binds", "-j"]
    stdout: StdioCollector {
      onStreamFinished: {
        if (Model.hasHoldBind(this.text)) return
        root.boundHere = true
        addBindProc.running = true
      }
    }
  }

  Process {
    id: addBindProc
    command: ["hyprctl", "eval", Model.holdBindLua(root.holdKeys)]
    stdout: StdioCollector {
      onStreamFinished: {
        if (this.text.trim() === "ok") { bindsProc.running = true; return }
        root.boundHere = false
        console.warn("tiling-hints: could not add the Super hold bind: " + this.text.trim())
      }
    }
  }

  // Disabling the plugin (or the shell going down) switches its bind off.
  Component.onDestruction: {
    if (boundHere) Quickshell.execDetached(["hyprctl", "eval", Model.holdDisableLua()])
  }

  Component.onCompleted: { ensureBind(); bindsProc.running = true; animationsProc.running = true; focusMethodProc.running = true }

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
      { desc: "Close window", label: strings.t("action.close"), core: true },
      { desc: "Toggle window floating/tiling", label: win.floating ? strings.t("action.tile") : strings.t("action.float"), core: true },
      { desc: "Full screen", label: strings.t("action.fullscreen"), core: true },
      { desc: "Toggle window split", label: strings.t("action.split"), tiledOnly: true, core: true },
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
      // A small window keeps just the four actions people reach for most.
      if (compact && !h.core) return false
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

  readonly property var emptyWindow: ({
    address: "", x: 0, y: 0, w: 0, h: 0, active: false, floating: false, fullscreen: 0, groupSize: 0,
    appClass: "", fromActive: "", neighbors: { l: false, r: false, u: false, d: false },
    monitorToward: { l: false, r: false, u: false, d: false }
  })

  // Matches Hyprland's window-move animation curve and length.
  component FrameMotion: NumberAnimation {
    duration: root.moveAnimation.duration
    easing.type: Easing.Bezier
    easing.bezierCurve: root.moveAnimation.bezier.concat([1, 1])
  }

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

  // A card of hints for one edge of a window.
  component EdgeCard: Card {
    property var hints: []
    Repeater {
      model: hints
      delegate: HintRow { required property var modelData; hint: modelData }
    }
  }

  // Wraps one card so the monitor's layout pass can place it. It reports its
  // size while `wanted`, and sits wherever the pass put it (in screen
  // coordinates, made local to its window frame, which may be animating).
  component Placed: Item {
    property var host: null
    property string cardId: ""
    property bool wanted: false
    property var frameRect: ({ x: 0, y: 0 })
    default property alias content: holder.data

    readonly property var place: host ? host.placements[cardId] : undefined
    readonly property int measuredW: Math.ceil(holder.childrenRect.width)
    readonly property int measuredH: Math.ceil(holder.childrenRect.height)

    width: measuredW
    height: measuredH
    x: place ? place.x - frameRect.x : 0
    y: place ? place.y - frameRect.y : 0
    visible: wanted && !!place && !place.hidden

    function report() { if (host) host.reportCard(cardId, wanted ? measuredW : 0, wanted ? measuredH : 0) }
    onWantedChanged: report()
    onMeasuredWChanged: report()
    onMeasuredHChanged: report()
    onCardIdChanged: report()
    onHostChanged: report()
    Component.onCompleted: report()
    Component.onDestruction: if (host) host.reportCard(cardId, 0, 0)

    Item { id: holder }
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

        readonly property var liveLayout: {
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
          return Model.build(windows, monitorIpc ? logicalRect(monitorIpc) : null, monitors, root.focusMethod)
        }

        // What is drawn. liveLayout re-evaluates on every poll; this only
        // changes when the windows do, and frames are keyed by address so a
        // moved window's frame animates rather than being rebuilt.
        property var layout: []
        property string layoutSignature: ""
        readonly property var byAddress: {
          var map = {}
          for (var i = 0; i < layout.length; i++) map[layout[i].address] = layout[i]
          return map
        }

        ListModel { id: frameModel }

        // ---- card layout pass
        property var cardSizes: ({})
        property var placements: ({})

        function reportCard(id, w, h) {
          var old = cardSizes[id]
          if (!(w > 0 && h > 0)) {
            if (!old) return
            var without = {}
            for (var k in cardSizes) if (k !== id) without[k] = cardSizes[k]
            cardSizes = without
          } else {
            if (old && old.w === w && old.h === h) return
            var next = {}
            for (var key in cardSizes) next[key] = cardSizes[key]
            next[id] = { w: w, h: h }
            cardSizes = next
          }
          Qt.callLater(win.placeAll)
        }

        readonly property var stripRect: strip.visible
          ? { x: strip.x, y: strip.y, w: strip.width, h: strip.height } : null
        onStripRectChanged: Qt.callLater(win.placeAll)
        onLayoutChanged: Qt.callLater(win.placeAll)

        function placeAll() {
          placements = Model.placeCards(layout, cardSizes, stripRect ? [stripRect] : [], {
            inset: Style.spacing.xl,
            gap: Style.spacing.md,
            screen: { w: win.width, h: win.height }
          })
        }

        onLiveLayoutChanged: {
          var signature = Model.signature(liveLayout)
          if (signature === layoutSignature) return
          layoutSignature = signature
          var next = liveLayout
          var wanted = {}
          for (var i = 0; i < next.length; i++) wanted[next[i].address] = true
          for (var j = frameModel.count - 1; j >= 0; j--)
            if (!wanted[frameModel.get(j).address]) frameModel.remove(j)
          layout = next
          var have = {}
          for (var k = 0; k < frameModel.count; k++) have[frameModel.get(k).address] = true
          for (var m = 0; m < next.length; m++)
            if (!have[next[m].address]) frameModel.append({ address: next[m].address })
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
          model: frameModel

          delegate: Item {
            id: frame
            required property string address
            readonly property var w: win.byAddress[address] || root.emptyWindow
            readonly property bool compact: w.w < 520 || w.h < 380

            // The active window's chips sit above its neighbours'.
            z: w.active ? 1 : 0
            x: w.x
            y: w.y
            width: w.w
            height: w.h

            Behavior on x { FrameMotion {} }
            Behavior on y { FrameMotion {} }
            Behavior on width { FrameMotion {} }
            Behavior on height { FrameMotion {} }

            // Frame wash and border: the active window in the accent, the rest muted.
            Rectangle {
              anchors.fill: parent
              radius: Style.cornerRadius
              color: Qt.alpha(Color.background, frame.w.active ? 0.30 : 0.55)
              border.width: frame.w.active ? 3 : 2
              border.color: frame.w.active ? Color.accent : Qt.alpha(Color.muted, 0.9)
            }

            // ---- active window: actions in the middle, edges on the edges
            Placed {
              host: win
              cardId: frame.address + "|center"
              wanted: frame.w.active
              frameRect: frame.w
              Card {
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
            }

            Repeater {
              model: frame.w.active && !frame.w.fullscreen ? ["l", "r", "u", "d"] : []
              delegate: Placed {
                id: edge
                required property var modelData
                readonly property var hints: frame.w.neighbors[modelData] ? root.edgeHints(modelData).slice(0, frame.compact ? 2 : 3)
                  : frame.w.monitorToward[modelData] ? root.monitorHints(modelData)
                  : []
                host: win
                cardId: frame.address + "|edge-" + modelData
                wanted: hints.length > 0
                frameRect: frame.w
                EdgeCard { hints: edge.hints }
              }
            }

            // Resize keys hug the bottom-right corner, where the size changes.
            // Optional: dropped when the window has no room left for them.
            Placed {
              host: win
              cardId: frame.address + "|resize"
              wanted: frame.w.active && !frame.w.floating && !frame.w.fullscreen
              frameRect: frame.w
              Card {
                pad: Style.spacing.md
                PlainText { text: strings.t("resize.title"); opacity: 0.7; font.pixelSize: Style.font.caption }
                Repeater {
                  model: frame.w.active ? root.resizeHints() : []
                  delegate: HintRow { required property var modelData; hint: modelData }
                }
              }
            }

            // Tabbed group controls sit along the top, where the tabs are.
            Placed {
              host: win
              cardId: frame.address + "|group"
              wanted: frame.w.active && frame.w.groupSize > 0
              frameRect: frame.w
              Card {
                pad: Style.spacing.md
                Repeater {
                  model: frame.w.active && frame.w.groupSize > 0 ? root.groupHints() : []
                  delegate: HintRow { required property var modelData; hint: modelData }
                }
              }
            }

            // ---- neighbours: the arrow that reaches them from the active window
            Placed {
              host: win
              cardId: frame.address + "|target"
              wanted: frame.w.fromActive !== ""
              frameRect: frame.w
              Column {
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
            }

            // Windows that are neither active nor next to it just get named.
            Placed {
              host: win
              cardId: frame.address + "|name"
              wanted: !frame.w.active && frame.w.fromActive === "" && frame.w.appClass !== ""
              frameRect: frame.w
              PlainText {
                text: frame.w.appClass
                opacity: 0.7
                font.pixelSize: Style.font.heading
              }
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
