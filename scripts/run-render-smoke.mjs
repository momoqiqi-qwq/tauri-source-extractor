/**
 * 用 esbuild 把 smoke-render.tsx 打成单文件再交给 node 跑。
 *
 * 为什么要绕这一下：node 的 `--experimental-strip-types` 只剥类型、**不转 JSX**，
 * 而组件全是 .tsx。esbuild 随 vite 一起装好了，直接拿来用，不引额外依赖。
 *
 * 运行：npm run verify:render
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 用 fileURLToPath 而不是 URL.pathname —— 后者不解码 %20，
// 而本项目路径里带空格（"tauri source提取"），会 ENOENT。
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "node_modules", ".tse-smoke");
const outFile = join(outDir, "render.mjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(here, "smoke-render.tsx")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  // react / react-dom 由 node_modules 解析，不要打进产物（否则体积大且可能双实例）
  external: ["react", "react-dom", "react-dom/server"],
  logLevel: "warning",
});

const res = spawnSync(process.execPath, [outFile], { stdio: "inherit" });
process.exit(res.status ?? 1);
