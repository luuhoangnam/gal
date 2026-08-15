<h1 align="center">gal</h1>

<p align="center">
  <b>One command. Every photo and video in a folder tree. Instantly.</b>
</p>

<p align="center">
  <a href="#license"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node >= 22" src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg">
  <img alt="Zero native deps" src="https://img.shields.io/badge/native%20deps-0-blueviolet.svg">
  <img alt="Status: alpha" src="https://img.shields.io/badge/status-alpha-orange.svg">
</p>

```console
$ gal ~/Pictures
http://127.0.0.1:53411
```

<p align="center"><img alt="gal grid" src="docs/screenshots/grid.png" width="820"></p>
<p align="center"><i>More: <a href="docs/screenshots/lightbox.png">lightbox</a> · <a href="docs/screenshots/filters.png">filters</a> · <a href="docs/screenshots/shortcuts.png">shortcuts</a></i></p>

Your photos are already on disk, organized in folders you made years ago. `gal` points a
browser at them. No import step, no library database to babysit, no server to keep running,
no account. Close the tab and it's over.

## Features

- **Recursive by default** — every subfolder, however deep, in one timeline. No per-folder browsing.
- **First photo in under a second** — the scan streams results as it walks; you never wait on a progress bar.
- **70,000 items, 60fps** — virtualized grid keeps the DOM under 2,000 nodes at any scroll position.
- **Real capture dates** — grouped by EXIF `DateTimeOriginal`, not by whatever the filesystem says.
- **Three layouts** — justified rows, square grid, masonry. Switch instantly, scroll position preserved.
- **Full-screen lightbox** — pinch/zoom, swipe, seekable video playback.
- **Filter, sort, group** — by type, date, folder; keyboard-driven throughout.
- **Zero native dependencies** — pure Node. No `sharp`, no `node-gyp`, no compiler, no install failures.
- **Read-only** — `gal` never writes to, moves, or renames anything in the folder you point it at.

## Install

Requires **Node ≥ 22** (uses the built-in `node:sqlite`) and **ffmpeg** on `PATH` —
it generates every thumbnail, photos included, so `gal` refuses to start without it
(`brew install ffmpeg`, `sudo apt install ffmpeg`, `winget install ffmpeg`).

```sh
git clone https://github.com/luuhoangnam/gal.git
cd gal && npm install && npm link
```

Not on npm yet — see [Status](#status).

## Usage

```sh
gal ~/Pictures                 # prints the URL, click it to open
gal . --port 8080              # fixed port instead of a random free one
gal ~/Photos --lan             # let phones and laptops on your Wi-Fi browse it
gal ~/Pictures --watch         # re-scan automatically when files change
gal ~/Pictures --follow-symlinks
gal ~/Pictures --include-bundles   # also descend into .photoslibrary, .app, ...
gal ~/Pictures --clear-cache       # drop that folder's index + thumbnails, then exit
```

`gal --help` lists every flag; the table below only adds what the one-liners don't say.

| Flag | Default | Meaning |
|---|---|---|
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--port <n>` | `0` (random free) | Port |
| `--lan` | off | Shorthand for `--host 0.0.0.0` |
| `--watch` | off | Re-scan automatically when the folder changes |
| `--include-bundles` | off | Descend into macOS bundle directories |
| `--follow-symlinks` | off | Follow directory symlinks |
| `--clear-cache` | — | Delete `<dir>/.gal` and print the space freed, then exit |
| `--version`, `--help` | — | Version; usage with examples |

### Keyboard

| Key | Action |
|---|---|
| `←` `→` `↑` `↓` | Move the selected tile |
| `Space` / `Enter` | Open the photo, play the video |
| `Esc` | Close lightbox → deselect → clear filters, in that order |
| `+` `−` `0` | Grid density; back to default |
| `1` `2` `3` | Justified / square / masonry |
| `G` | Jump to a date |
| `/` | Jump to the name filter |
| `R` | Re-scan the folder now |
| `Home` `End` | Top / bottom of the library |
| `?` | Shortcut sheet |

Every one of these is also a click somewhere. The keyboard is a shortcut, not the manual.

## How it works

```
gal <dir> ──► HTTP server on localhost ──► browser
                │
                ├─ walk    stream every media file as NDJSON as it is found
                ├─ meta    EXIF dates + dimensions, second pass, non-blocking
                ├─ index   SQLite (node:sqlite) cache in <dir>/.gal/index.db
                └─ thumbs  ffmpeg-generated, cached in <dir>/.gal/thumbs
```

Runtime state lives beside the library it describes: `gal ~/Pics` keeps everything under
`~/Pics/.gal`, so deleting the folder deletes its cache and an external drive carries its
index to another machine. If the folder is not writable, it falls back to
`/tmp/gal/<flattened-path>` (e.g. `/tmp/gal/Users-nam-Pics`).

Two passes. The walker streams filenames the instant it sees them, so the grid paints before
the scan finishes. A second pass fills in EXIF dates and dimensions and reflows. Results land
in a per-root SQLite cache, so the second `gal` on the same folder is immediate.

**Serving arbitrary files off your disk is the risky part**, so it is the part with the most
tests: every request path is resolved and confirmed to be inside the root before a single byte
is read, symlink escapes included, plus a `Host` header guard against DNS rebinding. `--lan`
prints a loud warning because it genuinely exposes those files to your network.

## Status

Alpha, and honest about it. The feature list above is all working today.

Not done yet: publishing to npm — install from git for now. Chrome only; other browsers are
untested, not deliberately excluded. Roadmap lives in [`plans/`](plans/).

`npm test` — no framework, just `node --test`.

## Contributing

Issues and PRs welcome, especially on the pieces above that aren't done. Run `npm test`
before opening one. No build step, no bundler, no transpiler — edit and run.

## License

MIT
