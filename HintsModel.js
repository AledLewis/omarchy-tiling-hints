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
    // 0 is the focused window, 1 the one before it, and so on.
    focusHistory: ipc.focusHistoryID === undefined ? 1e6 : Number(ipc.focusHistoryID),
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
//
// Several windows can touch one edge of the active window, but Super+arrow
// reaches only one of them. Hyprland picks it by `binds:focus_preferred_method`:
// 0 (default) the most recently focused, 1 the longest shared edge.
// The one window Super+arrow `dir` moves to from `from`, as Hyprland chooses.
function directionTarget(from, candidates, dir, focusMethod) {
  var best = null, bestLength = -1
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i]
    if (c === from || !isAdjacent(from, c, dir)) continue
    var length = dir === "l" || dir === "r"
      ? overlap(from.y, from.y + from.h, c.y, c.y + c.h)
      : overlap(from.x, from.x + from.w, c.x, c.x + c.w)
    var better
    if (Number(focusMethod) === 1) better = length > bestLength || (length === bestLength && best && c.focusHistory < best.focusHistory)
    else better = !best || c.focusHistory < best.focusHistory
    if (better) { best = c; bestLength = length }
  }
  return best
}

function build(windows, monitor, monitors, focusMethod) {
  var list = (windows || []).filter(function(w) { return !!w })
  var tiled = list.filter(function(w) { return !w.floating })
  var active = null
  for (var i = 0; i < list.length; i++) if (list[i].active) active = list[i]

  var anyFullscreen = list.some(function(w) { return w.fullscreen >= 1 })

  var targets = {}
  if (active && !active.floating) {
    for (var t = 0; t < DIRECTIONS.length; t++) targets[DIRECTIONS[t]] = directionTarget(active, tiled, DIRECTIONS[t], focusMethod)
  }

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
    for (var k = 0; k < DIRECTIONS.length; k++) {
      if (targets[DIRECTIONS[k]] === w) { fromActive = DIRECTIONS[k]; break }
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

// ------------------------------------------------------------ animation
//
// Hyprland reports a window's final geometry the moment a layout change
// starts, then animates the window there. The overlay animates its frames
// the same way, using Hyprland's own `windowsMove` animation as resolved
// through its tree (windowsMove -> windows -> global) from
// `hyprctl animations -j`: [ [animations], [beziers] ].

// The Super hold bind is added at runtime unless one already exists, which
// is how installs from before 0.4 set it up (by hand, in bindings.lua). The
// bind runs a Lua closure, so its description is the only thing to match on.
var HOLD_DESCRIPTION = "Show tiling hints"

function hasHoldBind(json) {
  var binds
  try { binds = JSON.parse(json) } catch (e) { return false }
  if (!Array.isArray(binds)) return false
  for (var i = 0; i < binds.length; i++)
    if (binds[i] && binds[i].description === HOLD_DESCRIPTION) return true
  return false
}

// The Lua run through `hyprctl eval` to manage that bind. The two bind
// handles live in a Lua global, so the plugin only ever touches its own
// binds: `hl.unbind(keys)` and, on Hyprland 0.56, a handle's
// `remove()`/`unbind()` clear every bind on the chord, including the user's.
// Unloading disables the handles instead. A config reload clears both the
// binds and the global.
//
// A handle can still outlive its bind (anything that unbinds Super_L at
// runtime, such as `o.rebind`), and on 0.56 calling `set_enabled` or
// `remove` on such a handle dereferences a null bind and crashes the
// compositor. `tostring()` is the one method that checks properly, so every
// call is guarded by it. Hyprland 0.57 fixes both problems.
var HOLD_GLOBAL = "tiling_hints_binds"
var HOLD_REUSED = "tiling-hints: reused"
var HOLD_EXPIRED = "HL.Keybind(expired)"

function holdAliveLua(h) {
  return "tostring(" + h + ") ~= \"" + HOLD_EXPIRED + "\""
}

// Turn back on the handles a previous shell left disabled (a restart with no
// config reload in between). The eval's error is the only way to report back.
// If either bind has gone, forget the handles so fresh binds are added.
function holdReuseLua() {
  var G = HOLD_GLOBAL
  return "if " + G + " then local alive = true; "
    + "for _, h in ipairs(" + G + ") do if not (" + holdAliveLua("h") + ") then alive = false end end; "
    + "if alive then for _, h in ipairs(" + G + ") do h:set_enabled(true) end; error(\"" + HOLD_REUSED + "\") end; "
    + "for _, h in ipairs(" + G + ") do if " + holdAliveLua("h") + " then h:set_enabled(false) end end; "
    + G + " = nil end"
}

function reusedHold(output) {
  return String(output || "").indexOf(HOLD_REUSED) !== -1
}

// What o.bind_hold does, but keeping the handles. Options mirror it: the
// release half must ignore the modifier mask, which changes as Super lifts.
function holdBindLua(keys) {
  var k = JSON.stringify(keys)
  return "local held = false; "
    + "local show, hide = \"omarchy-shell -q tiling-hints show\", \"omarchy-shell -q tiling-hints hide\"; "
    + "local function on_press() held = true; hl.exec_cmd(show) end; "
    + "local function on_release() if held then held = false; hl.exec_cmd(hide) end end; "
    + "if o and o.bind_commands then o.bind_commands[on_press] = show; o.bind_commands[on_release] = hide end; "
    + HOLD_GLOBAL + " = { "
    + "hl.bind(" + k + ", on_press, { description = \"" + HOLD_DESCRIPTION + "\", ignore_mods = true, non_consuming = true }), "
    + "hl.bind(" + k + ", on_release, { description = \"Hide tiling hints\", release = true, transparent = true, ignore_mods = true, non_consuming = true }) }"
}

function holdDisableLua() {
  return "if " + HOLD_GLOBAL + " then for _, h in ipairs(" + HOLD_GLOBAL + ") do "
    + "if " + holdAliveLua("h") + " then h:set_enabled(false) end end end"
}

var ANIMATION_PARENTS = { windowsMove: "windows", windows: "global" }

function windowMoveAnimation(json) {
  var fallback = { duration: 0, bezier: [0.23, 1, 0.32, 1] }
  var data
  try { data = typeof json === "string" ? JSON.parse(json) : json } catch (e) { return fallback }
  if (!Array.isArray(data) || !Array.isArray(data[0])) return fallback
  var anims = {}, curves = {}
  data[0].forEach(function(a) { if (a && a.name) anims[a.name] = a })
  ;(Array.isArray(data[1]) ? data[1] : []).forEach(function(c) { if (c && c.name) curves[c.name] = c })

  // Walk up until an animation that is actually configured.
  var name = "windowsMove", speed = null, bezier = "", enabled = true
  while (name) {
    var a = anims[name]
    if (a && (a.overridden || name === "global")) {
      if (a.enabled === false) enabled = false
      if (speed === null) speed = Number(a.speed)
      if (!bezier && a.bezier) bezier = String(a.bezier)
      break
    }
    name = ANIMATION_PARENTS[name]
  }
  if (!enabled || !(speed > 0)) return { duration: 0, bezier: fallback.bezier }
  var c = curves[bezier || "default"]
  var points = c ? [Number(c.X0), Number(c.Y0), Number(c.X1), Number(c.Y1)] : fallback.bezier
  // Hyprland speed is in deciseconds.
  return { duration: Math.round(speed * 100), bezier: points }
}

// A string that changes only when something drawn changes, so a 20 Hz
// refresh does not rebuild every hint while nothing moves.
function signature(layout) {
  return (layout || []).map(function(w) {
    return [w.address, w.x, w.y, w.w, w.h, w.active ? 1 : 0, w.floating ? 1 : 0, w.fullscreen, w.groupSize,
      w.fromActive, w.neighbors.l, w.neighbors.r, w.neighbors.u, w.neighbors.d,
      w.monitorToward.l, w.monitorToward.r, w.monitorToward.u, w.monitorToward.d, w.appClass].join(",")
  }).join("|")
}

// ------------------------------------------------------------ card placement
//
// Every hint card wants a spot inside its window (an edge card hugs its edge,
// the action card sits in the middle, ...). Cards are placed one at a time,
// most important first, each at the free spot closest to where it wants to
// be. A card that cannot fit anywhere without overlapping is either dropped
// (optional cards) or put where it overlaps least (essential ones).
//
// Card ids are "<window address>|<role>". Rects are in screen coordinates.

var ROLES = {
  center:   { h: "c", v: "c", priority: 1, optional: false },
  target:   { h: "c", v: "c", priority: 2, optional: false },
  "edge-l": { h: "s", v: "c", priority: 3, optional: false, along: "y" },
  "edge-r": { h: "e", v: "c", priority: 3, optional: false, along: "y" },
  "edge-u": { h: "c", v: "s", priority: 3, optional: false, along: "x" },
  "edge-d": { h: "c", v: "e", priority: 3, optional: false, along: "x" },
  group:    { h: "s", v: "s", priority: 4, optional: true },
  resize:   { h: "e", v: "e", priority: 5, optional: true },
  name:     { h: "c", v: "c", priority: 6, optional: true }
}

function roleOf(id) {
  var at = String(id).lastIndexOf("|")
  return at < 0 ? "" : String(id).slice(at + 1)
}

function addressOf(id) {
  var at = String(id).lastIndexOf("|")
  return at < 0 ? "" : String(id).slice(0, at)
}

function overlapArea(a, b) {
  var w = overlap(a.x, a.x + a.w, b.x, b.x + b.w)
  var h = overlap(a.y, a.y + a.h, b.y, b.y + b.h)
  return w > 0 && h > 0 ? w * h : 0
}

function alignedStart(start, span, size, how) {
  if (how === "s") return start
  if (how === "e") return start + span - size
  return start + (span - size) / 2
}

// layout:    windows from build() (x, y, w, h, address, active)
// sizes:     { id: { w, h } } — measured cards that want to be shown
// obstacles: fixed rects nothing may cover (the workspace strip)
// options:   { inset, gap, screen: { w, h } }
// Returns { id: { x, y, hidden } } with x, y in screen coordinates.
function placeCards(layout, sizes, obstacles, options) {
  var opts = options || {}
  var inset = opts.inset === undefined ? 10 : opts.inset
  var gap = opts.gap === undefined ? 6 : opts.gap
  var screen = opts.screen || null

  var frames = {}
  ;(layout || []).forEach(function(w) { frames[w.address] = w })

  var cards = []
  for (var id in sizes) {
    var size = sizes[id], role = ROLES[roleOf(id)], frame = frames[addressOf(id)]
    if (!size || !role || !frame || !(size.w > 0) || !(size.h > 0)) continue
    cards.push({ id: id, w: size.w, h: size.h, role: role, frame: frame })
  }
  // Most important first; the active window's cards before a neighbour's.
  cards.sort(function(a, b) {
    return (a.role.priority - b.role.priority)
      || ((b.frame.active ? 1 : 0) - (a.frame.active ? 1 : 0))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })

  // Placed rects are padded by `gap` so cards never touch.
  var placed = (obstacles || []).filter(function(o) { return o && o.w > 0 && o.h > 0 })
    .map(function(o) { return { x: o.x - gap, y: o.y - gap, w: o.w + gap * 2, h: o.h + gap * 2 } })
  var out = {}

  cards.forEach(function(card) {
    var f = card.frame
    // Where the card may go: inside its window, short of the border.
    var left = f.x + inset, top = f.y + inset, spanW = f.w - inset * 2, spanH = f.h - inset * 2
    // Too big for its window: centre it on that axis and let it spill.
    var fixedX = card.w > spanW, fixedY = card.h > spanH
    var px = fixedX ? alignedStart(f.x, f.w, card.w, "c") : alignedStart(left, spanW, card.w, card.role.h)
    var py = fixedY ? alignedStart(f.y, f.h, card.h, "c") : alignedStart(top, spanH, card.h, card.role.v)
    if (screen) {
      px = Math.max(0, Math.min(px, screen.w - card.w))
      py = Math.max(0, Math.min(py, screen.h - card.h))
    }

    // Candidate spots: the preferred one, the window's own edges, and
    // flush against every card placed so far.
    var xs = [px], ys = [py]
    if (!fixedX) xs.push(left, left + spanW - card.w)
    if (!fixedY) ys.push(top, top + spanH - card.h)
    placed.forEach(function(p) {
      if (!fixedX) xs.push(p.x - card.w, p.x + p.w)
      if (!fixedY) ys.push(p.y - card.h, p.y + p.h)
    })

    // An edge card should slide along its edge before leaving it.
    var along = card.role.along
    var best = null
    for (var i = 0; i < xs.length; i++) {
      for (var j = 0; j < ys.length; j++) {
        var x = xs[i], y = ys[j]
        if (!fixedX && (x < left - 0.5 || x + card.w > left + spanW + 0.5)) continue
        if (!fixedY && (y < top - 0.5 || y + card.h > top + spanH + 0.5)) continue
        var rect = { x: x, y: y, w: card.w, h: card.h }
        var covered = 0
        for (var k = 0; k < placed.length; k++) covered += overlapArea(rect, placed[k])
        var dx = Math.abs(x - px), dy = Math.abs(y - py)
        var distance = along === "y" ? dx * 4 + dy : along === "x" ? dx + dy * 4 : dx + dy
        if (!best || covered < best.covered || (covered === best.covered && distance < best.distance))
          best = { x: x, y: y, covered: covered, distance: distance }
      }
    }
    if (!best) best = { x: px, y: py, covered: 1 }

    if (best.covered > 0 && card.role.optional) {
      out[card.id] = { x: px, y: py, hidden: true }
      return
    }
    out[card.id] = { x: best.x, y: best.y, hidden: false }
    placed.push({ x: best.x - gap, y: best.y - gap, w: card.w + gap * 2, h: card.h + gap * 2 })
  })
  return out
}
