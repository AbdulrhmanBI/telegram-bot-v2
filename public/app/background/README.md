# Scrolling memories background (Cloudflare Workers)

This gallery is discovered at **build time from the files in this repository**. It does not call the GitHub API at runtime, does not require a public GitHub repository, and does not need a token.

## One-time Cloudflare setup

In Cloudflare Dashboard, open this Worker and go to **Settings → Builds → Build configuration**:

- **Build command:** `node tools/build-gallery-manifest.mjs`
- **Deploy command:** keep your current deploy command (usually `npx wrangler deploy`)
- **Root directory:** the project directory containing `wrangler.toml` and `tools/`. For the usual layout, this is the repository root.

Save the settings and run one new deployment. The build command scans the media folders and creates `public/app/background/gallery-manifest.json` automatically before Cloudflare deploys static assets. Do not change the Worker entry point, D1/KV bindings, secrets, or cron settings for this feature.

## Where to add files

- Photos: `public/app/background/photos/`
- Music: `public/app/background/music/`

Upload files to these folders in GitHub and push/commit them. Each commit triggers your existing Cloudflare deployment; the build step regenerates the manifest automatically. You never need to add filenames to the manifest manually. Subfolders are supported.

Supported photo formats: JPG/JPEG, PNG, WebP, AVIF, GIF.
Supported audio formats: MP3, M4A, AAC, OGG, OPUS, WAV, WebM.

The build script skips hidden files, unsupported formats, empty media files, symbolic links, and individual media files larger than 20 MiB. Cloudflare Workers Static Assets have a 25 MiB per-file limit, so keep files below 20 MiB. For best loading performance, prefer WebP/JPEG thumbnails around 640×480, roughly 60–200 KB each where quality allows. For 1,000 photos, compressing each photo substantially reduces initial bandwidth and repository size.

## Music selection

Edit `public/app/background/gallery-config.json` only if needed:

- `musicFile`: empty selects the first music file alphabetically. Or enter a filename, e.g. `class-song.mp3`, or a nested relative path within the music folder.
- `scrollDurationSeconds`: default scrolling duration is 210 seconds; smaller values move faster.
- `blueOverlay`: background tint, normally `#1D4ED8`.

If no music is uploaded, the button is disabled and the app works normally. Autoplay may be blocked by the browser or Telegram WebView; the user can tap the music button to start. The volume is kept low.

## Behavior and performance

- Photo order is shuffled on each Mini App load with Fisher–Yates; all discovered unique photos are distributed among the vertical tracks and eventually scroll through the viewport.
- Images are lazy-loaded and decoded asynchronously. The animation uses CSS transforms and does not require a background server process.
- The fixed background ignores pointer events, so tabs, search, filters, file selection, and sending remain interactive.
- A blue overlay and theme-aware dim layer soften photo colors. The background respects `prefers-reduced-motion`.
- If there are no photos or the manifest is temporarily unavailable, the bundled illustrated placeholders are shown instead.

## Visibility note

Files deployed as Worker Static Assets are served from your Worker URL, so anyone who knows that URL can access files placed in these folders. Do not upload private photos or audio unless you are comfortable making them publicly accessible and have permission to share them.
