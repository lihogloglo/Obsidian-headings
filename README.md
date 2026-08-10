# Floating Headings

A Google Docs style scroll handle for Obsidian, built for mobile and working the same
way on desktop.

Scroll a note and a round handle fades in on the right edge. Drag it and the note
scrolls with it while the note's headings float over the right side of the page as an
evenly spaced list, with the section you are currently in highlighted as a chip. Let go
and the headings linger for a couple of seconds so you can tap one and jump straight
there — it lands with the heading at the top of the screen. Ignore them and everything
fades away.

Works in editing mode (including Live Preview) and in reading mode.

## Install

Copy `manifest.json`, `main.js` and `styles.css` into
`<vault>/.obsidian/plugins/floating-headings/`, then enable **Floating Headings** under
Settings → Community plugins.

While developing, a junction avoids re-copying after every edit (run from an ordinary
terminal, no admin needed):

```
mklink /J "<vault>\.obsidian\plugins\floating-headings" "d:\Gamedev\Obsidian headings"
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Enable on desktop | on | Turn off to restrict the handle to mobile. |
| Always show the handle | off | Keep the handle on screen instead of fading it out. |
| Handle top margin | 72 px | How far down the screen the handle sits at the top of a note. Raise it if the handle is awkward to reach. |
| Hide the handle after | 1400 ms | Idle delay before the handle fades. |
| Keep headings after releasing | 2500 ms | How long headings stay tappable after you let go. |
| Deepest heading level | H6 | Headings deeper than this are never shown. |
| Spacing between headings | 32 px | Row height for the heading list — see below. |

There is also a command, **Floating Headings: Show floating headings**, which reveals
the headings without dragging. Handy on desktop, and bindable to a hotkey.

## How the heading list behaves

Headings are listed **evenly**, like Google Docs. The gaps say nothing about how far
apart the headings are in the note — two headings a paragraph apart and two headings
ten pages apart get the same spacing.

If they all fit, they spread down the rail. If a note has more headings than fit on
screen, the list becomes a window that slides through the full set as you drag, so
every heading stays reachable and the section you are in is always on screen. Lower
the spacing setting to fit more at once.

## How positions are worked out

Even though the labels are evenly spaced, the plugin still needs each heading's real
pixel offset — to know which section you are in, to slide the window in step with the
scroll, and to land a jump accurately. That differs by mode:

- **Editing / Live Preview** — CodeMirror keeps a height map covering the whole
  document, so `lineBlockAt` gives an offset for every heading even far off screen.
  Lines that have not been rendered yet use CodeMirror's own estimates, the same ones
  its native scrollbar uses, so far-away labels drift slightly until you scroll near
  them.
- **Reading mode** — the preview renderer splits the note into sections that carry
  their start line. Measuring the sections present in the DOM gives anchor points, and
  heading positions are interpolated between them.
- **Fallback** — if neither is available, headings are spread by line number over the
  content height.

Tapping a label calls Obsidian's own `applyScroll` to get the region rendered, then
measures the heading exactly and pins it to the top of the viewport, re-checking over
the next couple of frames as the layout settles.

## Notes

- Labels are anchored to the right edge and truncate with an ellipsis, so a long
  heading still lines up with the others.
- The handle does not travel the full height of the screen — it keeps a margin at the
  top (adjustable) and at the bottom so it stays easy to grab.
- The handle sits where Obsidian's right edge-swipe gesture lives on mobile. It claims
  the touch while you drag, so the sidebar should not open from under you.
