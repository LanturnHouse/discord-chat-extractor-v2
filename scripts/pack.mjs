// Zips dist/ into discord-chat-extractor-v2-<version>.zip at the repo root (zip root = the CONTENTS of dist/, which is what
// the Chrome Web Store expects: manifest.json at the top level). Verifies dist/ first and refuses a development build.
//   npm run build && npm run pack       (this script does not build)
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { isDevManifest, verifyDist } from './verify-dist.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Thrown for every reason a pack is refused; the message is meant for the person at the terminal. */
export class PackError extends Error {}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = posix.join(prefix, entry.name); // forward slashes in zip entry names on every OS
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Verifies `distDir` and writes `<rootDir>/discord-chat-extractor-v2-<version>.zip`. @returns {{ zipPath: string, fileCount: number, bytes: number }} */
export function packDist({ rootDir = ROOT, distDir = join(rootDir, 'dist') } = {}) {
  if (!existsSync(distDir)) throw new PackError('dist/ does not exist - run "npm run build" first');

  const { problems } = verifyDist({ distDir, rootDir });
  if (problems.length > 0) {
    throw new PackError(`${problems.map((problem) => `FAIL ${problem}`).join('\n')}\n\ndist/ failed verification; not packing`);
  }
  if (isDevManifest(JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')))) {
    throw new PackError('dist/ is a development build (it talks to the dev server); run "npm run build" and pack again');
  }

  const { version } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const files = {};
  for (const rel of listFiles(distDir).sort()) files[rel] = new Uint8Array(readFileSync(join(distDir, rel)));

  const zipPath = join(rootDir, `discord-chat-extractor-v2-${version}.zip`);
  rmSync(zipPath, { force: true });
  // A fixed timestamp makes the archive of an unchanged dist/ byte-identical from run to run.
  writeFileSync(zipPath, zipSync(files, { level: 9, mtime: new Date(2000, 0, 1) }));
  return { zipPath, fileCount: Object.keys(files).length, bytes: statSync(zipPath).size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { zipPath, fileCount, bytes } = packDist();
    console.log(`packed ${fileCount} files -> ${zipPath} (${(bytes / 1024).toFixed(1)} KiB)`);
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
