/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds to ONE self-contained index.html: no external JS, no external CSS,
 * no fetches at runtime. That is not cosmetic here - the multi-file version
 * of this app renders perfectly from file:// and then ignores every click,
 * because ES modules are CORS-blocked on a null origin and only the module
 * graph fails. Inlining removes the fetch, so the failure has nowhere to live.
 */
/*
 * A build stamp, shown in the header.
 *
 * This exists because the app is delivered as a bare `index.html` attachment.
 * Two of them an hour apart land in a Downloads folder as `index.html` and
 * `index (1).html`, and a bug report against the older one is indistinguishable
 * from a real defect - which cost a round trip on 2026-09-02. A visible stamp
 * makes "which build is that" answerable by the person holding it.
 */
const BUILD_STAMP = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  test: {
    define: { __BUILD_STAMP__: JSON.stringify('test') },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
