// Run: node tests/model.test.js
const fs = require("fs")
const path = require("path")
const assert = require("assert")
const vm = require("vm")

const src = fs.readFileSync(path.join(__dirname, "..", "HintsModel.js"), "utf8").replace(/^\.pragma library\s*$/m, "")
const M = {}
vm.runInNewContext(src + "\nthis.M = { build, normalizeClient, isAdjacent, parseBinds, resolve, rangeHint, keycaps, monitorToward, arrow };", M)
const { build, normalizeClient, parseBinds, resolve, rangeHint, keycaps, monitorToward } = M.M

const eq = (a, b, m) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, m)
let passed = 0
function test(name, fn) { fn(); passed++; console.log("ok -", name) }
const win = (x, y, w, h, extra) => Object.assign({ address: "0x" + x + y, x, y, w, h, floating: false, fullscreen: 0, groupSize: 0, appClass: "app", active: false }, extra)
const mon = { x: 0, y: 0, w: 2560, h: 1440 }

test("two side-by-side windows see each other", () => {
  const a = win(10, 40, 1260, 1390, { active: true }), b = win(1290, 40, 1260, 1390)
  const out = build([a, b], mon, [mon])
  const A = out.find(w => w.active), B = out.find(w => !w.active)
  eq(A.neighbors, { l: false, r: true, u: false, d: false })
  eq(B.neighbors, { l: true, r: false, u: false, d: false })
  assert.strictEqual(B.fromActive, "r")
  assert.strictEqual(out[out.length - 1].active, true, "active drawn last")
})

test("dwindle: right column split top/bottom", () => {
  const a = win(10, 40, 1260, 1390, { active: true })
  const b = win(1290, 40, 1260, 685), c = win(1290, 745, 1260, 685)
  const out = build([a, b, c], mon, [mon])
  const B = out.find(w => w.address === b.address), C = out.find(w => w.address === c.address)
  // Both touch the right edge, but Super+→ reaches only one.
  assert.strictEqual([B.fromActive, C.fromActive].filter(d => d === "r").length, 1)
  assert.strictEqual(B.neighbors.d, true)
  assert.strictEqual(C.neighbors.u, true)
  assert.strictEqual(B.neighbors.l, true)
})

test("floating windows get no neighbours and are not neighbours", () => {
  const a = win(10, 40, 1260, 1390, { active: true }), f = win(1290, 40, 600, 400, { floating: true })
  const out = build([a, f], mon, [mon])
  assert.strictEqual(out.find(w => w.active).neighbors.r, false)
  assert.strictEqual(out.find(w => w.floating).fromActive, "")
})

test("monitor to the right is offered when no window is there", () => {
  const right = { x: 2560, y: 0, w: 1920, h: 1080 }
  assert.strictEqual(monitorToward(mon, [mon, right], "r"), true)
  assert.strictEqual(monitorToward(mon, [mon, right], "l"), false)
  const out = build([win(10, 40, 2540, 1390, { active: true })], mon, [mon, right])
  assert.strictEqual(out[0].monitorToward.r, true)
  assert.strictEqual(out[0].monitorToward.l, false)
})

test("fullscreen hides everything else", () => {
  const out = build([win(0, 0, 2560, 1440, { fullscreen: 2 }), win(10, 40, 100, 100, { active: true })], mon, [mon])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].fullscreen, 2)
})

test("normalizeClient offsets by monitor and flags active", () => {
  const n = normalizeClient({ address: "0xabc", at: [2570, 30], size: [800, 600], floating: false, fullscreen: 0, grouped: ["0xabc", "0xdef"], class: "foot" }, 2560, 0, "0xabc")
  eq([n.x, n.y, n.w, n.h, n.active, n.groupSize, n.appClass], [10, 30, 800, 600, true, 2, "foot"])
  assert.strictEqual(normalizeClient({ at: [0, 0], size: [10, 10], focusHistoryID: 0 }, 0, 0, "").active, true)
  assert.strictEqual(normalizeClient({ at: [0, 0], size: [10, 10], focusHistoryID: 0, address: "0x1" }, 0, 0, "0x2").active, false)
  assert.strictEqual(normalizeClient({ at: [0, 0], size: [0, 0] }), null)
  assert.strictEqual(normalizeClient({ at: [0, 0], size: [10, 10], hidden: true }), null)
})

test("binds become keycaps, Super stripped, fewest modifiers preferred", () => {
  const binds = [
    { modmask: 64, key: "W", description: "Close window" },
    { modmask: 64, key: "Q", description: "Close window" },
    { modmask: 65, key: "LEFT", description: "Swap window to the left" },
    { modmask: 64, key: "", keycode: 10, description: "Switch to workspace 1" },
    { modmask: 64, key: "", keycode: 19, description: "Switch to workspace 10" },
    { modmask: 65, key: "", keycode: 10, description: "Move window to workspace 1" },
    { modmask: 65, key: "", keycode: 19, description: "Move window to workspace 10" },
    { modmask: 64, key: "", keycode: 20, description: "Expand window left" },
    { modmask: 64, key: "mouse:272", description: "Move window" },
    { modmask: 8, key: "TAB", description: "Not a super bind" },
    { modmask: 72, key: "TAB", description: "Next window in group" },
    { modmask: 76, key: "TAB", description: "Next window in group" }
  ]
  const idx = parseBinds(JSON.stringify(binds))
  eq(idx["Close window"], ["W"])
  eq(idx["Swap window to the left"], ["Shift", "←"])
  eq(idx["Expand window left"], ["-"])
  eq(idx["Move window"], ["Left drag"])
  eq(idx["Next window in group"], ["Alt", "Tab"])
  assert.strictEqual(idx["Not a super bind"], undefined)
  eq(rangeHint(idx, "Switch to workspace 1", "Switch to workspace 10", "ws").keys, ["1…0"])
  eq(rangeHint(idx, "Move window to workspace 1", "Move window to workspace 10", "send").keys, ["Shift", "1…0"])
  assert.strictEqual(rangeHint(idx, "Nope 1", "Nope 10", "x"), null)
})

test("resolve drops unbound actions and keeps order", () => {
  const idx = { "Close window": ["W"], "Full screen": ["F"] }
  const out = resolve([{ desc: "Full screen", label: "fs" }, { desc: "Gone", label: "x" }, { desc: ["Gone", "Close window"], label: "close" }], idx)
  eq(out, [{ keys: ["F"], label: "fs" }, { keys: ["W"], label: "close" }])
})

test("garbage bind JSON is harmless", () => {
  eq(parseBinds("not json"), {})
  eq(keycaps({ modmask: 5, key: "grave" }), ["Shift", "Ctrl", "`"])
})

console.log(`\n${passed} passed`)

const { parsePrinted } = (() => { const c = {}; vm.runInNewContext(src + "\nthis.p = { parsePrinted };", c); return c.p })()
test("parses omarchy's printed keybindings", () => {
  const idx = parsePrinted([
    "SUPER + W / SUPER + Q               → Close window",
    "SUPER + 1                           → Switch to workspace 1",
    "SUPER + 0                           → Switch to workspace 10",
    "SUPER SHIFT + 1                     → Move window to workspace 1",
    "SUPER SHIFT + 0                     → Move window to workspace 10",
    "SUPER SHIFT + LEFT                  → Swap window to the left",
    "SUPER + MINUS                       → Expand window left",
    "SUPER SHIFT + MINUS                 → Shrink window up",
    "SUPER + LEFT MOUSE BUTTON           → Move window",
    "SUPER ALT + mouse_down              → Next window in group",
    "SUPER ALT + TAB                     → Next window in group",
    "SUPER + ~                           → Toggle Quake console",
    "ALT + TAB                           → Focus on next window",
    "garbage line"
  ].join("\n"))
  eq(idx["Close window"], ["W"])
  eq(idx["Swap window to the left"], ["Shift", "←"])
  eq(idx["Expand window left"], ["-"])
  eq(idx["Shrink window up"], ["Shift", "-"])
  eq(idx["Move window"], ["Left drag"])
  eq(idx["Next window in group"], ["Alt", "Tab"])
  eq(idx["Toggle Quake console"], ["~"])
  assert.strictEqual(idx["Focus on next window"], undefined)
  eq(rangeHint(idx, "Switch to workspace 1", "Switch to workspace 10", "ws").keys, ["1…0"])
  eq(rangeHint(idx, "Move window to workspace 1", "Move window to workspace 10", "s").keys, ["Shift", "1…0"])
})
console.log(`${passed} passed`)

const A = (() => { const c = {}; vm.runInNewContext(src + "\nthis.a = { windowMoveAnimation, signature, build };", c); return c.a })()
test("window move animation follows Hyprland's tree", () => {
  const beziers = [{ name: "easeOutQuint", X0: 0.23, Y0: 1, X1: 0.32, Y1: 1 }, { name: "default", X0: 0, Y0: 0.75, X1: 0.15, Y1: 1 }]
  const live = [[
    { name: "global", overridden: true, bezier: "default", enabled: true, speed: 10 },
    { name: "windows", overridden: true, bezier: "easeOutQuint", enabled: true, speed: 3.79 },
    { name: "windowsMove", overridden: false, bezier: "", enabled: true, speed: 0 }
  ], beziers]
  eq(A.windowMoveAnimation(JSON.stringify(live)), { duration: 379, bezier: [0.23, 1, 0.32, 1] })
  const own = JSON.parse(JSON.stringify(live)); own[0][2] = { name: "windowsMove", overridden: true, bezier: "default", enabled: true, speed: 2 }
  eq(A.windowMoveAnimation(own), { duration: 200, bezier: [0, 0.75, 0.15, 1] })
  const off = JSON.parse(JSON.stringify(live)); off[0][1].enabled = false
  assert.strictEqual(A.windowMoveAnimation(off).duration, 0)
  assert.strictEqual(A.windowMoveAnimation("nope").duration, 0)
})

test("signature ignores identity, tracks geometry", () => {
  const mk = x => A.build([win(x, 40, 1260, 1390, { active: true })], mon, [mon])
  assert.strictEqual(A.signature(mk(10)), A.signature(mk(10)))
  assert.notStrictEqual(A.signature(mk(10)), A.signature(mk(20)))
})
console.log(`${passed} passed`)

const B2 = (() => { const c = {}; vm.runInNewContext(src + "\nthis.b = { build };", c); return c.b })()
test("Super+arrow marks only the window Hyprland will pick", () => {
  // The live case: foot focused, chrome above-left (focused 1 ago), terminal below-left (2 ago).
  const active = win(1326, 38, 294, 1390, { active: true, focusHistory: 0 })
  const chrome = win(12, 38, 1300, 900, { address: "chrome", focusHistory: 1 })
  const term = win(12, 952, 1300, 476, { address: "term", focusHistory: 2 })
  const pick = (method, a, b) => {
    const out = B2.build([active, a, b], mon, [mon], method)
    return out.filter(w => w.fromActive === "l").map(w => w.address)
  }
  eq(pick(0, chrome, term), ["chrome"])
  eq(pick(0, Object.assign({}, chrome, { focusHistory: 3 }), term), ["term"])
  // Longest shared edge: chrome overlaps 900px, the terminal 476px.
  eq(pick(1, Object.assign({}, chrome, { focusHistory: 3 }), term), ["chrome"])
  // The edge itself still knows there are neighbours that way.
  assert.strictEqual(B2.build([active, chrome, term], mon, [mon], 0).find(w => w.active).neighbors.l, true)
})

const P = (() => { const c = {}; vm.runInNewContext(src + "\nthis.p = { placeCards, overlapArea };", c); return c.p })()
function noOverlaps(places, sizes, obstacles) {
  const rects = Object.keys(places).filter(id => !places[id].hidden)
    .map(id => ({ id, x: places[id].x, y: places[id].y, w: sizes[id].w, h: sizes[id].h }))
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++)
      assert.strictEqual(P.overlapArea(rects[i], rects[j]), 0, rects[i].id + " overlaps " + rects[j].id)
    for (const o of obstacles || []) assert.strictEqual(P.overlapArea(rects[i], o), 0, rects[i].id + " covers an obstacle")
  }
}

test("cards in a narrow column stop colliding", () => {
  // The Super+J case: active foot squeezed into a 294px column.
  const layout = [{ address: "a", x: 1326, y: 38, w: 294, h: 1390, active: true }]
  const sizes = { "a|center": { w: 160, h: 130 }, "a|edge-l": { w: 120, h: 80 }, "a|edge-r": { w: 120, h: 80 } }
  const places = P.placeCards(layout, sizes, [], { inset: 10, gap: 6 })
  noOverlaps(places, sizes)
  // The action card keeps the middle; the edge cards stay on their own edges.
  assert.strictEqual(places["a|center"].y, 38 + (1390 - 130) / 2)
  assert.strictEqual(places["a|edge-l"].x, 1336)
  assert.strictEqual(places["a|edge-r"].x, 1326 + 294 - 10 - 120)
})

test("a roomy window leaves everything where it wants to be", () => {
  const layout = [{ address: "a", x: 0, y: 0, w: 2000, h: 1200, active: true }]
  const sizes = { "a|center": { w: 400, h: 200 }, "a|edge-l": { w: 120, h: 80 }, "a|resize": { w: 120, h: 100 } }
  const places = P.placeCards(layout, sizes, [], { inset: 10, gap: 6 })
  eq(places["a|center"], { x: 800, y: 500, hidden: false })
  eq(places["a|edge-l"], { x: 10, y: 560, hidden: false })
  eq(places["a|resize"], { x: 2000 - 10 - 120, y: 1200 - 10 - 100, hidden: false })
})

test("cards dodge the workspace strip", () => {
  const layout = [{ address: "a", x: 0, y: 0, w: 1300, h: 1400, active: true }]
  const strip = { x: 760, y: 1330, w: 1040, h: 40 }
  const sizes = { "a|resize": { w: 140, h: 100 }, "a|edge-d": { w: 400, h: 60 } }
  const places = P.placeCards(layout, sizes, [strip], { inset: 10, gap: 6 })
  noOverlaps(places, sizes, [strip])
  assert.strictEqual(places["a|resize"].hidden, false)
})

test("optional cards give way when there is no room", () => {
  const layout = [{ address: "a", x: 0, y: 0, w: 300, h: 260, active: true }]
  const sizes = { "a|center": { w: 260, h: 200 }, "a|resize": { w: 140, h: 100 } }
  const places = P.placeCards(layout, sizes, [], { inset: 10, gap: 6 })
  assert.strictEqual(places["a|center"].hidden, false)
  assert.strictEqual(places["a|resize"].hidden, true)
})

test("a card bigger than its window spills evenly and keeps out of the others", () => {
  const layout = [
    { address: "a", x: 0, y: 0, w: 100, h: 1000, active: true },
    { address: "b", x: 110, y: 0, w: 900, h: 1000, active: false }
  ]
  const sizes = { "a|center": { w: 160, h: 130 }, "b|target": { w: 200, h: 180 } }
  const places = P.placeCards(layout, sizes, [], { inset: 10, gap: 6 })
  noOverlaps(places, sizes)
  assert.strictEqual(places["a|center"].x, -30)
})
const HB = (() => { const c = {}; vm.runInNewContext(src + "\nthis.h = { hasHoldBind, holdBindLua, holdReuseLua, holdDisableLua, reusedHold };", c); return c.h })()

test("an existing Super hold bind is found by its description", () => {
  const bind = (description, key) => ({ key, modmask: 64, dispatcher: "__lua", description })
  assert.strictEqual(HB.hasHoldBind(JSON.stringify([bind("Close window", "W"), bind("Show tiling hints", "Super_L")])), true)
  assert.strictEqual(HB.hasHoldBind(JSON.stringify([bind("Close window", "W")])), false)
  assert.strictEqual(HB.hasHoldBind(JSON.stringify([bind("Show tiling hints", "Super_R")])), true, "a rebound key still counts")
  assert.strictEqual(HB.hasHoldBind(""), false)
  assert.strictEqual(HB.hasHoldBind("{}"), false)
})
test("the hold bind Lua keeps its handles and never unbinds the chord", () => {
  const all = [HB.holdBindLua("SUPER + Super_L"), HB.holdReuseLua(), HB.holdDisableLua()].join("\n")
  assert.ok(!/unbind|:remove\(/.test(all), "nothing chord-wide or crash-prone")
  const bind = HB.holdBindLua("SUPER + Super_L")
  assert.strictEqual((bind.match(/hl\.bind\("SUPER \+ Super_L"/g) || []).length, 2)
  assert.ok(bind.includes('description = "Show tiling hints"'), "matches what hasHoldBind looks for")
  assert.ok(/release = true, transparent = true, ignore_mods = true/.test(bind))
  assert.ok(HB.holdDisableLua().includes("set_enabled(false)"))
  assert.ok(HB.holdReuseLua().includes("set_enabled(true)"))
})

test("a reuse is read from the eval's error text", () => {
  assert.strictEqual(HB.reusedHold('error: [string "if tiling_hints_binds..."]:1: tiling-hints: reused'), true)
  assert.strictEqual(HB.reusedHold("ok"), false)
  assert.strictEqual(HB.reusedHold(""), false)
})
console.log(`${passed} passed`)
