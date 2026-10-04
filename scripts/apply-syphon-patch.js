// Overwrite node-syphon's prebuilt native addon with our patched build.
//
// node-syphon 1.5.0's SyphonMetalServer.publishImageData leaks one full-
// resolution MTLTexture per published frame (upstream issue #45). At 30 fps
// that grows unbounded — multi-GB in minutes. The fix (upstream PR #46,
// unmerged) releases the texture in the command buffer's completion handler.
// We ship a locally-built, patched syphon.node in vendor/ and copy it over the
// installed binary after every `npm install` so the fix survives reinstalls.
//
// N-API makes syphon.node ABI-stable, so the plain-node build loads fine in
// Electron. Remove this once PR #46 (or an equivalent) ships upstream.

const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'vendor', 'node-syphon', 'syphon.node');
const dest = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-syphon',
  'dist',
  'bin',
  'syphon.node',
);

// Syphon is macOS-only (Windows uses the Spout addon, see build-spout.js).
if (process.platform !== 'darwin') process.exit(0);

if (!fs.existsSync(src)) {
  console.warn(`[apply-syphon-patch] vendored binary missing: ${src} — skipping`);
  process.exit(0);
}
if (!fs.existsSync(path.dirname(dest))) {
  console.warn(`[apply-syphon-patch] node-syphon not installed — skipping`);
  process.exit(0);
}

fs.copyFileSync(src, dest);
console.log('[apply-syphon-patch] applied patched syphon.node (fixes publishImageData leak)');
