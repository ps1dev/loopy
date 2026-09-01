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
export default defineConfig({
  test: {
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
