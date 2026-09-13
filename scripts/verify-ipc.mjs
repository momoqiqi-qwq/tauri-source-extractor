/**
 * 校验「前端 invoke 的命令名」与「后端 generate_handler 注册的命令名」完全一致。
 *
 * 为什么要单独兜一层：命令名写错**不会在编译期报错**，
 * tsc 能过、cargo test 能过、构建能过，只有运行时点下去才报
 * `command xxx not found`。这正是这个项目反复遇到的那类「静默失败」。
 *
 * 运行：npm run verify:ipc
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// 注意：不能用 URL.pathname —— 它不会解码 %20 之类的转义，
// 本项目路径里带空格（"tauri source提取"）会直接找不到目录。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(ROOT, "src");
const LIB_RS = join(ROOT, "src-tauri", "src", "lib.rs");

/** 递归收集 src 下所有 .ts / .tsx */
function collectSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectSources(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** 前端调用的命令名 */
const frontend = new Map(); // name -> Set<file>
for (const file of collectSources(SRC_DIR)) {
  const text = readFileSync(file, "utf8");
  // 同时匹配 invoke<T>("name", ...) 与 invoke("name", ...)
  const re = /\binvoke\s*(?:<[^<>]*>)?\s*\(\s*"([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const set = frontend.get(m[1]) ?? new Set();
    set.add(relative(ROOT, file).replace(/\\/g, "/"));
    frontend.set(m[1], set);
  }
}

/** 后端注册的命令名 */
const libText = readFileSync(LIB_RS, "utf8");
const blockMatch = libText.match(/generate_handler!\s*\[([\s\S]*?)\]/);
if (!blockMatch) {
  console.error("FAIL  在 lib.rs 里找不到 generate_handler![...]");
  process.exit(1);
}
const backend = new Set(
  blockMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("::").pop().trim())
    .filter(Boolean)
);

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
};

// 1) 前端调的每个命令都必须已注册
for (const [name, files] of frontend) {
  if (!backend.has(name)) {
    fail(`前端调用了未注册的命令 "${name}"（${[...files].join(", ")}）`);
  }
}

// 2) 注册了但前端没用到的命令 → 只是提示，不算失败（可能是预留）
const unused = [...backend].filter((n) => !frontend.has(n));

if (failures === 0) {
  console.log(`PASS  前端 ${frontend.size} 个命令全部已在后端注册`);
  for (const n of [...frontend.keys()].sort()) console.log(`        ${n}`);
  if (unused.length) console.log(`提示  后端注册但前端未使用：${unused.join(", ")}`);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
