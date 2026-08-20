import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { deepseekProxyPlugin } from "./src/server/deepseek-proxy";

// Phase 0 goal: keep the exact "one file, double-click, offline" deliverable.
// vite-plugin-singlefile inlines all JS/CSS into one dist/index.html.
//
// deepseekProxyPlugin adds dev-server-only routes (/api/deepseek/*) so the app
// can reach DeepSeek without the browser holding a key — the key lives in the
// server environment as DEEPSEEK_API_KEY. It does not affect the single-file
// build (no server there), where the app uses the in-browser key instead.
export default defineConfig({
  plugins: [deepseekProxyPlugin(), viteSingleFile()],
  build: {
    target: "es2020",
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
