// `npm run dev`: a watching development build and the build-id server (scripts/dev-server.mjs), side by side in one terminal.
//   - `vite build --watch --mode development` rewrites dist/ on every source change (src/**, public/**, package.json);
//   - the development build of the service worker polls http://localhost:5858/build-id and reloads the extension + the open
//     Discord tabs after each rebuild (src/background/devReload.ts).
// Load dist/ once via chrome://extensions -> Developer mode -> "Load unpacked"; after that every save reloads itself.
// Ctrl+C stops both processes.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Run vite's own entry file with the current node: no `.cmd` shim or shell needed (works the same on Windows and POSIX).
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');

// A watch rebuild never empties dist/ (so Chrome can reload from it at any moment): start from a clean one instead.
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });

const children = [];
const exited = [];
let stopping = false;

function run(label, args) {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => console.log(`[${label}] ${line}`));
  }
  exited.push(
    new Promise((resolveExit) => {
      child.once('exit', (code) => {
        resolveExit();
        if (!stopping) {
          console.error(`[${label}] exited with code ${code}; stopping`);
          stop(code ?? 1);
        }
      });
    }),
  );
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 3000).unref(); // do not hang on a child that ignores the signal
  void Promise.all(exited).then(() => process.exit(code));
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => stop(0));

console.log('dev: watching src/ and public/; dist/ is rebuilt on every change. Load dist/ unpacked in chrome://extensions once.');
run('dev-server', [join(ROOT, 'scripts', 'dev-server.mjs')]);
run('vite', [viteBin, 'build', '--watch', '--mode', 'development']);
