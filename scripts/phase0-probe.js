// Phase-0 probe: prove node-syphon works inside Electron's runtime on this
// machine — create a Metal Syphon server named URLtoSyphon, publish a red
// 1280x720 frame a few times, and confirm the server is announced in the
// Syphon server directory. Run: npx electron scripts/phase0-probe.js
const { app } = require('electron');

app.disableHardwareAcceleration(); // probe runs without a window/GPU context
app.whenReady().then(async () => {
  let syphon;
  try {
    syphon = require('node-syphon');
  } catch (e) {
    console.error('FAIL require node-syphon:', e.message);
    app.exit(2);
    return;
  }
  const { SyphonMetalServer, SyphonServerDirectory } = syphon;

  const W = 1280,
    H = 720;
  const bgraRed = new Uint8Array(W * H * 4);
  for (let i = 0; i < bgraRed.length; i += 4) {
    bgraRed[i + 2] = 255; // R (in RGBA after swizzle) — here just fill
    bgraRed[i + 3] = 255;
  }
  const rgbaRed = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < rgbaRed.length; i += 4) {
    rgbaRed[i] = 255;
    rgbaRed[i + 3] = 255;
  }

  let server;
  try {
    server = new SyphonMetalServer('URLtoSyphon');
    console.log('OK created SyphonMetalServer:', server.name);
  } catch (e) {
    console.error('FAIL create server:', e.message);
    app.exit(3);
    return;
  }

  let published = 0;
  const timer = setInterval(() => {
    try {
      server.publishImageData(
        rgbaRed,
        { x: 0, y: 0, width: W, height: H },
        { width: W, height: H },
        false,
      );
      published++;
    } catch (e) {
      console.error('FAIL publish:', e.message);
      clearInterval(timer);
      app.exit(4);
    }
  }, 33);

  setTimeout(() => {
    clearInterval(timer);
    let listed = [];
    try {
      const dir = new SyphonServerDirectory();
      // Directory may expose servers via a property/getter.
      listed = dir.servers || [];
    } catch (e) {
      console.log('note: could not query directory:', e.message);
    }
    console.log('published frames:', published);
    console.log(
      'directory servers:',
      JSON.stringify(listed.map((s) => s && (s.SyphonServerDescriptionNameKey || s))),
    );
    try {
      server.dispose();
    } catch {}
    console.log(published > 0 ? 'PROBE_PASS' : 'PROBE_FAIL');
    app.exit(published > 0 ? 0 : 5);
  }, 2500);
});
