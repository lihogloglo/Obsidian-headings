# Floating Headings

A Google Docs style scroll handle for Obsidian, built for mobile and working the same
way on desktop.

Scroll a note and a round handle fades in on the right edge. Drag it and the note
scrolls with it while every heading floats over the right side of the page, each one
sitting at the height it occupies in the document. The section you are currently in is
highlighted as a chip. Let go and the headings linger for a couple of seconds so you
can tap one and jump straight there. Ignore them and everything fades away.

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
| Hide the handle after | 1400 ms | Idle delay before the handle fades. |
| Keep headings after releasing | 2500 ms | How long headings stay tappable after you let go. |
| Deepest heading level | H6 | Headings deeper than this are never shown. |
| Minimum spacing between headings | 26 px | Crowding threshold — see below. |

There is also a command, **Floating Headings: Show floating headings**, which reveals
the headings without dragging. Handy on desktop, and bindable to a hotkey.

## How positions are worked out

Each label sits at the handle position that would put its heading at the top of the
screen, so a label's height on screen is literally where you have to drag to reach it.

Getting a heading's pixel offset differs by mode:

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

When headings would overlap, labels are dropped by depth: H1s survive, deeper levels
give way first. If the heading you are currently in was dropped, the nearest surviving
label above it is highlighted instead, so the chip never disappears mid-drag.

## Notes

- Labels are anchored to the right edge and truncate with an ellipsis, so a long
  heading still lines up with the others.
- Headings within the last screenful of the note all collapse toward the bottom of the
  rail. That is inherent to scrollbar geometry — the note cannot scroll past its end.
- The handle sits where Obsidian's right edge-swipe gesture lives on mobile. It claims
  the touch while you drag, so the sidebar should not open from under you.
