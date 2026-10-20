# Scrolling memories — Option A

The Mini App keeps its original solid light/dark theme background. The posters run in one narrow portrait strip at the right edge behind the interface; they do not replace the full background. Posters stay complete (3:4), with no crop, frame or strong blue tint. The strip scrolls vertically and uses the local generated manifest.

## Add photos
Put supported image files (`.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, or `.gif`) in `public/app/background/photos/`. Keep each photo below 20 MiB; smaller optimized files load faster. `node tools/build-gallery-manifest.mjs` scans the folder and rebuilds `gallery-manifest.json` during deployment.

Music remains optional. Put audio in `public/app/background/music/`.
