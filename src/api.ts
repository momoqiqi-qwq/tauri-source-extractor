import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  BundleResult,
  DetectedProject,
  ExtractOptions,
  ScanResult,
  ZipResult,
} from "./types";

/** 选择一个或多个项目文件夹 */
export async function pickFolders(title = "选择项目文件夹（可多选）"): Promise<string[]> {
  const res = await open({ directory: true, multiple: true, title });
  if (Array.isArray(res)) return res.filter((x): x is string => typeof x === "string");
  if (typeof res === "string") return [res];
  return [];
}

/** 选择单个文件夹 */
export async function pickFolder(title = "选择文件夹"): Promise<string | null> {
  const res = await open({ directory: true, multiple: false, title });
  return typeof res === "string" ? res : null;
}

export async function scanProject(root: string): Promise<ScanResult> {
  return invoke<ScanResult>("scan_project", { root });
}

/** 在父目录里自动发现子项目 */
export async function detectProjects(
  root: string,
  maxDepth = 3
): Promise<DetectedProject[]> {
  return invoke<DetectedProject[]>("detect_projects", { root, maxDepth });
}

export interface ProjectPayload {
  name: string;
  root: string;
  selected: string[];
}

export async function extractBundle(
  projects: ProjectPayload[],
  options: ExtractOptions
): Promise<BundleResult> {
  return invoke<BundleResult>("extract_bundle", { projects, options });
}

export async function saveTextFile(
  defaultName: string,
  content: string,
  ext: string
): Promise<string | null> {
  const path = await save({
    title: "保存提取包",
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: "Text", extensions: [ext] }],
  });
  if (typeof path !== "string") return null;
  return invoke<string>("save_text_file", { path, content });
}

/**
 * 一键把勾选的关键源码打包成 zip。
 * 先弹出保存对话框选好路径，再让后端按原始目录结构写压缩包；
 * 取消选择返回 null。与合并文本导出不同，zip 保留文件本体（含二进制）。
 */
export async function saveZipBundle(
  defaultName: string,
  projects: ProjectPayload[]
): Promise<ZipResult | null> {
  const path = await save({
    title: "打包关键源码为 zip",
    defaultPath: `${defaultName}.zip`,
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (typeof path !== "string") return null;
  return invoke<ZipResult>("extract_zip", { projects, path });
}

export function extForFormat(format: ExtractOptions["format"]): string {
  return format === "xml" ? "xml" : format === "plain" ? "txt" : "md";
}

/** 在系统文件管理器里显示该文件（zip 打包完成后的「打开文件夹」用） */
export async function revealInFolder(path: string): Promise<void> {
  await revealItemInDir(path);
}
