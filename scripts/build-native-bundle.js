// Assemble a minimal node_modules tree containing node-syphon and its full
// runtime dependency chain, to be shipped as an extraResource.
//
// Why: Electron Forge's Vite plugin does not ship node_modules inside the asar,
// and npm hoists node-syphon's deps (bindings -> file-uri-to-path) to the
// top-level node_modules, so shipping node-syphon alone fails at runtime with
// "Cannot find module 'bindings'". We copy node-syphon + its deps into
// native-bundle/node_modules so Node's resolution (Resources/node_modules/...)
// finds everything. syphon.ts requires node-syphon from there when packaged.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const srcModules = path.join(root, 'node_modules');
const outModules = path.join(root, 'native-bundle', 'node_modules');

// node-syphon's runtime dependency closure (kept explicit + tiny on purpose).
const PACKAGES = ['node-syphon', 'bindings', 'file-uri-to-path'];

fs.rmSync(path.join(root, 'native-bundle'), { recursive: true, force: true });
fs.mkdirSync(outModules, { recursive: true });

for (const pkg of PACKAGES) {
  const from = path.join(srcModules, pkg);
  const to = path.join(outModules, pkg);
  if (!fs.existsSync(from)) {
    throw new Error(`[build-native-bundle] missing dependency: ${from}`);
  }
  // Use `ditto` (not fs.cpSync) so Syphon.framework's symlinks are preserved
  // VERBATIM. fs.cpSync({dereference:true}) rewrote the framework's relative
  // symlinks (e.g. Resources -> Versions/Current/Resources) into ABSOLUTE paths
  // on the build machine, which dangle on any other Mac — Syphon then can't load
  // its default.metallib and aborts in -[SyphonServerRendererMetal init...].
  execFileSync('ditto', [from, to], { stdio: 'inherit' });
}

console.log(
  `[build-native-bundle] staged ${PACKAGES.join(', ')} -> native-bundle/node_modules`,
);
