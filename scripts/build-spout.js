// Build the Windows Spout sender addon (native/spout -> spout.node).
//
// Runs from postinstall; a no-op anywhere but Windows. Uses the node-gyp that
// ships with npm (no extra dependency). Needs the Visual Studio Build Tools
// ("Desktop development with C++" workload) on the machine.
//
// The addon is plain Node-API, so a build against the installed Node's headers
// loads fine in Electron (same as the vendored syphon.node).
//
// A failed build only warns: the app still starts, and starting an output
// then reports the missing addon in the UI.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'win32') process.exit(0);

const root = path.join(__dirname, '..');
const addonDir = path.join(root, 'native', 'spout');

// npm exports its bundled node-gyp to lifecycle scripts; fall back to the copy
// next to npm-cli.js when run some other way.
function nodeGypPath() {
  const fromEnv = process.env.npm_config_node_gyp;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.env.npm_execpath) {
    const p = path.join(
      path.dirname(process.env.npm_execpath),
      '..',
      'node_modules',
      'node-gyp',
      'bin',
      'node-gyp.js',
    );
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const gyp = nodeGypPath();
if (!gyp) {
  console.warn('[build-spout] node-gyp not found (run via npm) — skipping');
  process.exit(0);
}

try {
  execFileSync(process.execPath, [gyp, 'rebuild'], {
    cwd: addonDir,
    stdio: 'inherit',
  });
  console.log('[build-spout] built native/spout/build/Release/spout.node');
} catch {
  console.warn(
    '[build-spout] build FAILED — Spout output will be unavailable. ' +
      'Install the Visual Studio Build Tools (Desktop development with C++) ' +
      'and run `npm run build:spout`.',
  );
}
