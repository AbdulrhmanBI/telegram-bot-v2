# Mini App background: class photos + optional music

A fixed, decorative, slowly scrolling collage sits behind the app. It never receives taps and never touches search, filters,
cart, files or sending. If anything fails, the app looks and works exactly as before.

```
public/app/background/
  gallery-config.json   <- the only file you edit
  gallery.js / .css     <- the feature (no need to touch)
  photos/               <- put the photos here
  music/                <- put the music here (optional)
```

## 1. One-time setup

Edit `gallery-config.json`:

| key | meaning | default |
|---|---|---|
| `owner`, `repo`, `branch` | your **public** GitHub repository | `""`, `""`, `main` |
| `projectPath` | folder of this project inside the repo, if it is nested (e.g. `apps/telegram-bot-main`); empty = repo root | `""` |
| `photosFolder` / `musicFolder` | folders, relative to `projectPath` | `public/app/background/photos` / `.../music` |
| `manifest` | static list file next to `gallery.js`; `""` = always ask GitHub | `photos.json` |
| `cacheTtlMinutes` | how long the file list is cached on the phone | `5` |
| `mediaHost` | `raw` = raw.githubusercontent.com, `jsdelivr` = cdn.jsdelivr.net | `raw` |
| `scrollDurationSeconds` | seconds a column needs to move by **one screen height**. Bigger = slower | `40` |
| `maxPhotos` | never use more than this many | `3000` |
| `maxImageBytes` | larger images are ignored | `1500000` |
| `tileAspect` | width ÷ height of each tile. Photos are shown **whole** (never cropped): set it to your photos' shape (portrait 3:4 = `0.75`, landscape 4:3 = `1.333`) | `0.75` |
| `ghostOpacity` | how visible the photos are: grey and faint over the app's own background colour (0.03 = almost invisible … 0.6 = strong) | `0.16` |
| `tintOpacity` | optional Royal Blue (#1D4ED8) veil, 0 = none | `0` |
| `musicFile` | exact music file name; empty = first file alphabetically | `""` |
| `musicVolume` | 0–1 | `0.18` |
| `autoplayMusic` | try to start music on launch | `true` |
| `startMusicOnFirstTap` | if autoplay is blocked, start on the first tap | `true` |
| `enabled` | `false` turns the whole feature off | `true` |

## 2. Adding photos

Commit images to `photos/` (sub-folders are fine). Formats: JPG/JPEG, PNG, WebP, AVIF, GIF. Files above `maxImageBytes` are skipped.

Best results: **small thumbnails, ~320×240, 20–40 KB** each (they are shown about 130 px wide; bigger files only cost the viewers mobile data).

**How the app finds them (no server cost):**

1. **`photos.json`** (default) is a tiny static list sitting next to `gallery.js`. The app reads it and makes **no GitHub API call at all**
   (so no rate limit). The photo and music files themselves are always loaded **directly from GitHub**, never through your Cloudflare Worker.
   Regenerate it whenever you add or remove files:
   ```
   node tools/build-gallery-manifest.mjs          # writes public/app/background/photos.json
   node tools/build-gallery-manifest.mjs --check  # CI: fails if it is out of date
   ```
   or let GitHub do it: `.github/workflows/gallery-manifest.yml` rebuilds and commits `photos.json` on every push that touches `photos/` or `music/`
   (if the project is in a sub-folder of the repo, move that file to the repo root's `.github/workflows/` and set `PROJECT_DIR`).
2. If `photos.json` is missing, empty or broken, the app falls back to the GitHub repository tree (one anonymous API call, cached for `cacheTtlMinutes`,
   last cached list used if GitHub is unavailable or rate-limited). Set `"manifest": ""` to always use this way.
3. Nothing found / no repo configured: built-in placeholder tiles, no error.

`public/.assetsignore` keeps `photos/` and `music/` out of the files uploaded with the Worker (they are served from GitHub anyway).

All photos are used on every launch, in a **new random order each time** (Fisher–Yates in the phone, not stored), spread over 3 columns on
phones and 4 on wider screens. Each column moves at a slightly different speed, starting point and direction.
Only anonymous public GitHub access is used: **never put a token in the front end**.

## 3. Music (optional)

Put audio in `music/`: MP3, M4A, AAC, OGG, OPUS, WAV, WebM. Set `musicFile` to pick one by its file name; if it is empty (or not
found) the **first file alphabetically** is played. It loops at volume 0.18.

A small music icon appears next to the theme button (only when a track exists):
not playing → tap to start; playing → tap to mute / unmute. `aria-label` and `title` follow the state.
Browsers and Telegram may block autoplay; then the first tap anywhere starts the music. If you muted on purpose, it is not restarted next time.
Music pauses while the app is in the background.

## 4. Privacy

The repository is public, so **every photo and song in it is public to anyone**. Do not publish classmates', family or childhood
photos without their permission, and use music you are allowed to use.
