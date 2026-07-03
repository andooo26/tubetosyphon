import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // node-syphon is a native N-API addon (loads Syphon.framework via rpath).
      // It must NOT be bundled by Vite/Rollup — keep it external so it is
      // required from node_modules at runtime (where its ../Frameworks rpath
      // and prebuilt syphon.node resolve).
      external: ['node-syphon'],
    },
  },
});
