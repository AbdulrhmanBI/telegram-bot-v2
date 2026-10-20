#!/usr/bin/env node
/**
 * Build a static manifest for the scrolling-memory background.
 * Runs in Cloudflare Workers Builds before `wrangler deploy`.
 * No external APIs, secrets, npm dependencies, or manual per-file manifest edits.
 */
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PHOTOS_DIR = path.join(PUBLIC_DIR, 'app', 'background', 'photos');
const MUSIC_DIR = path.join(PUBLIC_DIR, 'app', 'background', 'music');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'app', 'background', 'gallery-manifest.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.webm']);
// Cloudflare Workers Static Assets allow individual assets up to 25 MiB.
// Keep media below 20 MiB to leave a safety margin and avoid unexpectedly heavy uploads.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
}

async function listMedia(directory, allowedExtensions, publicPrefix) {
  const output = [];
  async function walk(currentDirectory) {
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    for (const entry of entries) {
      // Ignore Git placeholders and hidden operating-system files.
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(currentDirectory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue;

      const info = await stat(absolute);
      if (info.size <= 0 || info.size > MAX_MEDIA_BYTES) {
        console.warn(`[gallery] Skipped ${path.relative(ROOT, absolute)} (${info.size} bytes; allowed range is 1 byte–20 MiB).`);
        continue;
      }

      const relativePath = path.relative(directory, absolute).split(path.sep).join('/');
      const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
      output.push({
        name: path.basename(relativePath),
        relativePath,
        url: `${publicPrefix}/${encodedPath}`,
        bytes: info.size,
      });
    }
  }
  await walk(directory);
  output.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en', { sensitivity: 'base' }));
  return output;
}

await Promise.all([ensureDirectory(PHOTOS_DIR), ensureDirectory(MUSIC_DIR)]);
const [photos, music] = await Promise.all([
  listMedia(PHOTOS_DIR, IMAGE_EXTENSIONS, '/app/background/photos'),
  listMedia(MUSIC_DIR, AUDIO_EXTENSIONS, '/app/background/music'),
]);

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  photos,
  music,
};
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[gallery] Wrote ${path.relative(ROOT, MANIFEST_PATH)}: ${photos.length} photo(s), ${music.length} audio file(s).`);
if (!photos.length) console.log('[gallery] No photos found; the Mini App will show its bundled demo background until photos are added.');
if (!music.length) console.log('[gallery] No music found; background music stays optional and the music button will be inactive.');
