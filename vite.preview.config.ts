import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 只用于构建 `preview/` 下的设计预览（见 preview/main.tsx）。
 *
 * 与产品构建分开，所以：
 * - 不会污染 dist/（产物在 design-preview/）
 * - 不会影响 `npm run build` 和 Tauri 打包
 * - base 用相对路径，产物可以直接当本地文件打开
 */
export default defineConfig({
  root: "preview",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../design-preview",
    emptyOutDir: true,
  },
});
