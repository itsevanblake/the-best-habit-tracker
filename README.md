# The Best Habit Tracker

A click-to-toggle habit heatmap for [Obsidian](https://obsidian.md), embeddable directly in any note.

## Features

- **Click-to-toggle** day cells — no editing markdown, no separate daily notes needed.
- **Live stats** on every habit: current streak, all-time total, and total this year.
- **Forgiving streaks**: a single missed day doesn't reset your streak — only two missed days in a row do.
- **Three views**, switchable with a single toggle that applies to every habit at once:
  - **Year** — a fixed Jan–Dec calendar-year heatmap.
  - **Month** — the current calendar month as a weekday grid.
  - **Week** — the current week (Sun–Sat) as larger labeled cells.
- **Add, edit, and delete habits** directly from the widget, with a color picker per habit.
- Future days are clickable too, for backfilling or pre-planning.
- Works on desktop and mobile.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from this repo.
2. Create a folder named `habit-tracker` inside your vault's `.obsidian/plugins/` directory.
3. Copy the three files into it.
4. In Obsidian, go to **Settings → Community plugins**, make sure Restricted Mode is off, and enable **The Best Habit Tracker**.

### Building from source

```bash
npm install
npm run build
```

This produces `main.js` from `main.ts` via esbuild. Copy the built files into your vault's `.obsidian/plugins/habit-tracker/` as above.

## Usage

Embed a tracker anywhere with a fenced code block:

````markdown
```habit-tracker
```
````

With no options, this renders every habit you've defined, plus an "Add habit" button.

**Show only one habit:**

````markdown
```habit-tracker
habit: Morning Run
```
````

**Default to a specific view** (`week`, `month`, or `year` — defaults to `year`):

````markdown
```habit-tracker
view: week
```
````

A toggle in the top-right of the rendered block still lets you switch views on the fly; the `view:` option only sets that block's *default* each time the note is opened.

### Daily Notes integration

A nice pattern is embedding a `habit-tracker` block in your Daily Notes template, so it auto-appears in every new daily note. Habit data itself is stored centrally by the plugin (not per-note), so every embedded block anywhere in the vault stays in sync.

## Data storage

Habit definitions and check-in history are stored in the plugin's own `data.json` (via Obsidian's `loadData`/`saveData`), not scattered across note content.

## License

MIT
