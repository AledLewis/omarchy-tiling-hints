# Tiling hints

Hold **Super** and, after a quarter second, every window on screen gets the keys that act on it:

- **Active window** (accent border): a card of actions (close, float/tile, fullscreen, split, pseudo, pop, group, minimize…), and on each edge that touches another window, the keys to focus, swap, or join a group that way. An edge facing another monitor shows "window to monitor" and "workspace to monitor" instead. Resize keys sit in the bottom-right corner, and group tab keys along the top when the window is grouped.
- **Neighbouring windows**: a big arrow plus the focus and swap keys that reach them from the active window.
- **Bottom strip** (focused monitor): workspace switching and sending, next/last, scratchpad, layout, mouse drag, and `K` for every key.

Keys are never hard-coded. They come from `omarchy menu keybindings --print`, so rebinds in `~/.config/hypr/bindings.lua` appear in the hints and anything you unbind disappears from them. The overlay is click-through and never takes focus, so Super chords and Super+drag work as normal while it is up.

## Install

```bash
omarchy plugin add https://github.com/AledLewis/omarchy-tiling-hints --enable
```

Then bind the Super hold in `~/.config/hypr/bindings.lua`:

```lua
o.bind_hold("SUPER + Super_L", "Show tiling hints", "omarchy-shell -q tiling-hints show",
  "Hide tiling hints", "omarchy-shell -q tiling-hints hide",
  { ignore_mods = true, non_consuming = true })
```

Hyprland reloads on save. Update later with `omarchy plugin update aledlewis.tiling-hints`.

### Developing

Clone the repo anywhere and symlink it in place of the installed copy:

```bash
ln -sfn "$PWD" ~/.config/omarchy/plugins/aledlewis.tiling-hints
```

The shell loads service plugins once, so run `omarchy restart shell` after editing the QML.

## Tuning

At the top of `Service.qml`: `showDelay` (ms before the overlay appears, so quick chords don't flash it) and `maxHold` (safety auto-hide if a key release is ever missed).

## IPC

`omarchy-shell tiling-hints show | hide | toggle | state`

## Tests

`node tests/model.test.js`: window adjacency, monitor edges, fullscreen, and keybinding parsing.
