.pragma library

// Pure geometry for the tiling hints overlay. Nothing in here touches QML or
// Hyprland, so it can be tested with plain node (see tests/model.test.js).
//
// Rectangles are { x, y, w, h } in the monitor's logical coordinates.

// How far apart two window edges may be and still count as touching. Covers
// Hyprland's gaps_in on both windows plus borders on typical configs.
var ADJACENT_TOLERANCE = 48

var DIRECTIONS = ["l", "r", "u", "d"]

function overlap(a0, a1, b0, b1) {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

// Is `other` directly beside `win` in direction `dir`: edges touching (within
// the tolerance) and sharing a meaningful run of the perpendicular axis.
function isAdjacent(win, other, dir, tolerance) {
  var tol = tolerance === undefined ? ADJACENT_TOLERANCE : tolerance
  var minRun = 8
  if (dir === "l" || dir === "r") {
    if (overlap(win.y, win.y + win.h, other.y, other.y + other.h) < minRun) return false
    var gapX = dir === "l" ? win.x - (other.x + other.w) : other.x - (win.x + win.w)
    return gapX >= -tol && gapX <= tol
  }
  if (overlap(win.x, win.x + win.w, other.x, other.x + other.w) < minRun) return false
  var gapY = dir === "u" ? win.y - (other.y + other.h) : other.y - (win.y + win.h)
  return gapY >= -tol && gapY <= tol
}

// Is there another monitor in direction `dir` from monitor rect `mon`, among
// `monitors` (global logical rects, `mon` included)?
function monitorToward(mon, monitors, dir) {
  if (!mon || !monitors) return false
  for (var i = 0; i < monitors.length; i++) {
    var m = monitors[i]
    if (m.x === mon.x && m.y === mon.y && m.w === mon.w && m.h === mon.h) continue
    if (dir === "l" && m.x + m.w <= mon.x + 1 && overlap(mon.y, mon.y + mon.h, m.y, m.y + m.h) > 0) return true
    if (dir === "r" && m.x >= mon.x + mon.w - 1 && overlap(mon.y, mon.y + mon.h, m.y, m.y + m.h) > 0) return true
    if (dir === "u" && m.y + m.h <= mon.y + 1 && overlap(mon.x, mon.x + mon.w, m.x, m.x + m.w) > 0) return true
    if (dir === "d" && m.y >= mon.y + mon.h - 1 && overlap(mon.x, mon.x + mon.w, m.x, m.x + m.w) > 0) return true
  }
  return false
}

// Turn a Hyprland `clients -j` style object into the shape this model uses.
// Returns null for anything that is not a usable mapped window.
function normalizeClient(ipc, monitorX, monitorY, activeAddress) {
  if (!ipc || !ipc.at || !ipc.size) return null
  var w = Number(ipc.size[0]), h = Number(ipc.size[1])
  if (!(w > 0 && h > 0)) return null
  if (ipc.hidden === true || ipc.mapped === false) return null
  var address = String(ipc.address || "")
  var grouped = Array.isArray(ipc.grouped) ? ipc.grouped.length : 0
  return {
    address: address,
    x: Number(ipc.at[0]) - (monitorX || 0),
    y: Number(ipc.at[1]) - (monitorY || 0),
    w: w,
    h: h,
    floating: !!ipc.floating,
    fullscreen: Number(ipc.fullscreen || 0),
    pseudo: !!ipc.pseudo,
    pinned: !!ipc.pinned,
    groupSize: grouped > 1 ? grouped : 0,
    appClass: String(ipc.class || ""),
    // Quickshell only learns the active window from a focus event, so right
    // after a shell restart fall back to Hyprland's focus history.
    active: activeAddress ? address === activeAddress : Number(ipc.focusHistoryID) === 0
  }
}

// Build the hint layout for one monitor.
//   windows  — normalized windows on the monitor's visible workspace
//   monitor  — this monitor's global logical rect (for monitor-edge hints)
//   monitors — every monitor's global logical rect
// Each returned window gains:
//   neighbors        { l, r, u, d } — a tiled window sits right beside it
//   monitorToward    { l, r, u, d } — no neighbor, but another monitor lies that way
//   fromActive       "l"|"r"|"u"|"d"|"" — the key that focuses it from the active window
function build(windows, monitor, monitors) {
  var list = (windows || []).filter(function(w) { return !!w })
  var tiled = list.filter(function(w) { return !w.floating })
  var active = null
  for (var i = 0; i < list.length; i++) if (list[i].active) active = list[i]

  var anyFullscreen = list.some(function(w) { return w.fullscreen >= 1 })

  var out = list.map(function(w) {
    var neighbors = { l: false, r: false, u: false, d: false }
    var toward = { l: false, r: false, u: false, d: false }
    for (var d = 0; d < DIRECTIONS.length; d++) {
      var dir = DIRECTIONS[d]
      if (!w.floating) {
        for (var j = 0; j < tiled.length; j++) {
          if (tiled[j] === w) continue
          if (isAdjacent(w, tiled[j], dir)) { neighbors[dir] = true; break }
        }
      }
      if (!neighbors[dir]) toward[dir] = monitorToward(monitor, monitors, dir)
    }

    var fromActive = ""
    if (active && active !== w && !active.floating && !w.floating) {
      for (var k = 0; k < DIRECTIONS.length; k++) {
        if (isAdjacent(active, w, DIRECTIONS[k])) { fromActive = DIRECTIONS[k]; break }
      }
    }

    var copy = {}
    for (var key in w) copy[key] = w[key]
    copy.neighbors = neighbors
    copy.monitorToward = toward
    copy.fromActive = fromActive
    return copy
  })

  // When something is fullscreen only it is visible; hint just that one.
  if (anyFullscreen) {
    out = out.filter(function(w) { return w.fullscreen >= 1 || w.active })
    if (out.length > 1) out = out.filter(function(w) { return w.fullscreen >= 1 })
    out.forEach(function(w) {
      w.neighbors = { l: false, r: false, u: false, d: false }
      w.fromActive = ""
    })
  }

  // Draw the active window last so its chips sit on top.
  out.sort(function(a, b) { return (a.active ? 1 : 0) - (b.active ? 1 : 0) })
  return out
}

var ARROWS = { l: "←", r: "→", u: "↑", d: "↓" }

function arrow(dir) {
  return ARROWS[dir] || ""
}

// ------------------------------------------------------------ key labels
//
// Hints never hard-code keys. Each one names the bind *description* Omarchy
// gives it (see `hyprctl binds -j`), and the overlay shows whatever key is
// bound to that description right now, so personal rebinds are picked up.

var MOD_BITS = [
  { bit: 1, label: "Shift" },
  { bit: 4, label: "Ctrl" },
  { bit: 8, label: "Alt" }
]
var SUPER_BIT = 64

var KEY_NAMES = {
  LEFT: "←", RIGHT: "→", UP: "↑", DOWN: "↓",
  RETURN: "Enter", SPACE: "Space", TAB: "Tab", ESCAPE: "Esc",
  BACKSPACE: "Bksp", DELETE: "Del", HOME: "Home", END: "End",
  GRAVE: "`", SLASH: "/", PERIOD: ".", COMMA: ",", MINUS: "-", EQUAL: "=",
  "MOUSE:272": "Left drag", "MOUSE:273": "Right drag",
  MOUSE_DOWN: "Scroll ↓", MOUSE_UP: "Scroll ↑"
}

// X keycodes Omarchy binds by code so they work on any layout.
var KEYCODE_NAMES = {
  10: "1", 11: "2", 12: "3", 13: "4", 14: "5", 15: "6", 16: "7", 17: "8", 18: "9", 19: "0",
  20: "-", 21: "="
}

function keyName(key, keycode) {
  var k = String(key || "")
  var code = /^code:(\d+)$/i.exec(k)
  if (code) return KEYCODE_NAMES[Number(code[1])] || k
  if (!k && keycode) return KEYCODE_NAMES[Number(keycode)] || ("code:" + keycode)
  var named = KEY_NAMES[k.toUpperCase()]
  if (named) return named
  return k.length === 1 ? k.toUpperCase() : k
}

// The keycaps to press while Super is already held: modifiers then the key.
function keycaps(bind) {
  var caps = []
  var mask = Number(bind.modmask || 0)
  for (var i = 0; i < MOD_BITS.length; i++) if (mask & MOD_BITS[i].bit) caps.push(MOD_BITS[i].label)
  caps.push(keyName(bind.key, bind.keycode))
  return caps
}

function modCount(mask) {
  var n = 0
  for (var i = 0; i < MOD_BITS.length; i++) if (mask & MOD_BITS[i].bit) n++
  return n
}

// { description: keycaps[] } for every Super bind, preferring the binding
// with the fewest extra modifiers when one description has several keys.
function indexBinds(binds) {
  var best = {}
  var list = Array.isArray(binds) ? binds : []
  for (var i = 0; i < list.length; i++) {
    var b = list[i]
    if (!b || !b.description) continue
    var mask = Number(b.modmask || 0)
    if (!(mask & SUPER_BIT)) continue
    if (b.release) continue
    var desc = String(b.description)
    var score = modCount(mask)
    if (!best[desc] || score < best[desc].score) best[desc] = { score: score, caps: keycaps(b) }
  }
  var out = {}
  for (var d in best) out[d] = best[d].caps
  return out
}

function parseBinds(text) {
  try { return indexBinds(JSON.parse(String(text || "[]"))) } catch (e) { return {} }
}

// Resolve a hint list ({ desc, label }) against the bind index, dropping any
// hint whose action is no longer bound. `desc` may be an array of
// alternatives; the first bound one wins.
function resolve(hints, index) {
  var out = []
  for (var i = 0; i < hints.length; i++) {
    var h = hints[i]
    var descs = Array.isArray(h.desc) ? h.desc : [h.desc]
    for (var j = 0; j < descs.length; j++) {
      var caps = index[descs[j]]
      if (caps) { out.push({ keys: caps, label: h.label }); break }
    }
  }
  return out
}

// Collapse the ten workspace binds into one "1 … 0" style hint.
function rangeHint(index, firstDesc, lastDesc, label) {
  var a = index[firstDesc], b = index[lastDesc]
  if (!a || !b) return null
  var keys = a.slice(0, a.length - 1)
  keys.push(a[a.length - 1] + "…" + b[b.length - 1])
  return { keys: keys, label: label }
}

// ------------------------------------------------- `omarchy menu keybindings --print`
//
// Hyprland reports `code:NN` Lua binds with keycode 0, so `hyprctl binds -j`
// cannot say which key moves to workspace 1. Omarchy's keybindings menu
// resolves those against the live keyboard layout, so its printed list is the
// source of truth:  "SUPER SHIFT + LEFT    → Swap window to the left"

var PRINTED_KEYS = {
  "LEFT MOUSE BUTTON": "Left drag", "RIGHT MOUSE BUTTON": "Right drag",
  "MIDDLE MOUSE BUTTON": "Middle drag",
  MOUSE_DOWN: "Scroll ↓", MOUSE_UP: "Scroll ↑",
  MINUS: "-", EQUAL: "=", PLUS: "+"
}
var PRINTED_MODS = ["SHIFT", "CTRL", "ALT"]
var PRINTED_MOD_LABELS = { SHIFT: "Shift", CTRL: "Ctrl", ALT: "Alt" }

function printedKeyName(key) {
  var k = String(key || "").trim()
  var upper = k.toUpperCase()
  if (PRINTED_KEYS[upper]) return PRINTED_KEYS[upper]
  if (KEY_NAMES[upper] && !/^MOUSE:/.test(upper)) return KEY_NAMES[upper]
  return k.length === 1 ? k.toUpperCase() : k
}

// One printed combo ("SUPER SHIFT + LEFT") -> { caps, score }, or null when
// it is not a Super chord.
function parseCombo(combo) {
  var at = combo.indexOf(" + ")
  if (at < 0) return null
  var mods = combo.slice(0, at).trim().toUpperCase().split(/\s+/)
  var key = combo.slice(at + 3).trim()
  if (mods.indexOf("SUPER") < 0 || !key) return null
  var caps = []
  for (var i = 0; i < PRINTED_MODS.length; i++)
    if (mods.indexOf(PRINTED_MODS[i]) >= 0) caps.push(PRINTED_MOD_LABELS[PRINTED_MODS[i]])
  var extra = mods.filter(function(m) { return m !== "SUPER" && PRINTED_MODS.indexOf(m) < 0 })
  if (extra.length) return null
  caps.push(printedKeyName(key))
  // Prefer fewer modifiers, then a real key over a scroll wheel.
  var score = caps.length + (/^mouse_(up|down)$/i.test(key) ? 0.5 : 0)
  return { caps: caps, score: score }
}

function parsePrinted(text) {
  var best = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var arrowAt = line.indexOf("→")
    if (arrowAt < 0) continue
    var desc = line.slice(arrowAt + 1).trim()
    if (!desc) continue
    var combos = line.slice(0, arrowAt).split(" / ")
    for (var j = 0; j < combos.length; j++) {
      var parsed = parseCombo(combos[j].trim())
      if (!parsed) continue
      if (!best[desc] || parsed.score < best[desc].score) best[desc] = parsed
    }
  }
  var out = {}
  for (var d in best) out[d] = best[d].caps
  return out
}
