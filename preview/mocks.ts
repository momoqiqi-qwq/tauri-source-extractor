/**
 * 设计预览用的 mock 数据。
 *
 * 量级刻意贴近真实体检结果，并覆盖**所有样式分支**：
 * - 三档预算颜色（绿 ≤128k / 黄 ≤256k / 红 >256k）
 * - 三种项目状态（就绪 / 扫描中 / 扫描失败）
 * - 三种 kind（TAURI / NODE / RUST / OTHER）
 *
 * 这样一眼就能看出样式有没有漏掉某个分支。
 */
import type { Category, FileEntry, ProjectEntry, ProjectKind } from "../src/types";

let uid = 0;

const CATEGORIES: Category[] = [
  "tauri-config",
  "rust",
  "frontend",
  "config",
  "docs",
  "other",
];

function mkFiles(n: number, sizeEach: number): FileEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const category = CATEGORIES[i % CATEGORIES.length];
    const inSrcTauri = category === "tauri-config" || category === "rust";
    const ext =
      category === "rust"
        ? "rs"
        : category === "tauri-config"
          ? "json"
          : category === "config"
            ? "toml"
            : category === "docs"
              ? "md"
              : "ts";
    const dir =
      inSrcTauri ? "src-tauri/src" : category === "frontend" ? "src" : "";
    const file = `mod${String(i).padStart(3, "0")}.${ext}`;
    const relPath = dir ? `${dir}/${file}` : file;
    return {
      relPath,
      absPath: "",
      name: file,
      dir,
      ext,
      category,
      size: sizeEach,
      lines: Math.max(1, Math.round(sizeEach / 34)),
      // 让「仅关键」有实际差别：docs / other 不算关键
      isKey: category !== "docs" && category !== "other",
      isText: true,
      isSecret: false,
    };
  });
}

export function mkProject(
  name: string,
  root: string,
  kind: ProjectKind,
  nFiles: number,
  nSelected: number,
  sizeEach: number,
  status: "ready" | "loading" | "error" = "ready",
  error?: string
): ProjectEntry {
  uid += 1;
  const files = mkFiles(nFiles, sizeEach);
  const selected = new Set(files.slice(0, nSelected).map((f) => f.relPath));
  return {
    id: `mock_${uid}`,
    root,
    name,
    kind,
    collapsed: false,
    status,
    error,
    scan:
      status === "ready"
        ? {
            root,
            projectName: name,
            projectKind: kind,
            files,
            stats: [],
            totalFiles: nFiles,
            totalBytes: nFiles * sizeEach,
            totalLines: files.reduce((s, f) => s + f.lines, 0),
            ignoredDirs: ["node_modules", "target", "dist", "src-tauri/gen"],
          }
        : null,
    selected,
  };
}

/** 覆盖三档预算 + 三种状态的样例集合 */
export function mkProjects(): ProjectEntry[] {
  return [
    mkProject(
      "tiez-clipboard-master",
      "E:\\E-Develop-Project\\tiez-clipboard-master",
      "tauri",
      294,
      220,
      7300 // ≈446k tokens → 红
    ),
    mkProject(
      "tauri-builder",
      "E:\\E-Develop-Project\\tauri-builder",
      "tauri",
      132,
      98,
      6500 // ≈177k tokens → 黄
    ),
    mkProject(
      "easy-espanso",
      "E:\\E-Develop-Project\\easy-espanso",
      "node",
      46,
      31,
      2600 // ≈22k tokens → 绿
    ),
    mkProject(
      "floorp-account-switcher",
      "E:\\E-Develop-Project\\floorp-account-switcher",
      "rust",
      28,
      0,
      1800
    ),
    mkProject(
      "微信web开发者工具",
      "E:\\E-Develop-Project\\微信web开发者工具",
      "unknown",
      0,
      0,
      0,
      "loading"
    ),
    mkProject(
      "broken-project",
      "E:\\E-Develop-Project\\broken-project",
      "unknown",
      0,
      0,
      0,
      "error",
      "目录不存在或不是文件夹：E:\\E-Develop-Project\\broken-project"
    ),
  ];
}
