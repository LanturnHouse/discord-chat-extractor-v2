// Starts the popup preview dev server (src/ui/preview/vite.config.ts) without opening a system browser tab.
//
//   node scripts/preview-popup.mjs   → http://localhost:5859/popup.html?mock=1
import { createServer } from 'vite';

const server = await createServer({
  configFile: new URL('../src/ui/preview/vite.config.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  server: { open: false },
});
await server.listen();
server.printUrls();
