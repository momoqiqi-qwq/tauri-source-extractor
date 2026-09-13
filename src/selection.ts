/**
 * 勾选状态相关的**纯逻辑**：不依赖 React、不碰 DOM，方便单独校验。
 *
 * 这里出错会**静默破坏用户的勾选**（不报错、只是少勾/多勾），
 * 所以刻意从组件里抽出来，由 `scripts/verify-sel-delta.ts` 做往返断言。
 */

import type { Category } from "./types";

export interface FileLike {
  relPath: string;
  isKey: boolean;
}

/** 带分类的文件 —— 分类勾选需要用到 */
export interface CategorizedFile extends FileLike {
  category: Category;
}

/** 工具条上的批量操作 */
export type BulkMode = "all" | "none" | "key" | "invert";

/**
 * 每个项目只持久化「与默认值的差异」，而不是完整勾选集合。
 *
 * 默认勾选可以由扫描结果重新算出来（`isKey`），所以只需记住用户改了什么：
 * - `off`：本来默认勾选（isKey）但被用户取消的
 * - `on` ：本来默认不勾选但被用户选上的
 *
 * 存储量只与「用户改动的数量」成正比。实测默认 220 个文件的项目，
 * 存全量要 220 条路径，存增量通常只有个位数到几十条。
 */
export interface SelDelta {
  off: string[];
  on: string[];
}

export type SelMap = Record<string, SelDelta>;

/** 默认勾选 = 所有关键文件 */
export function defaultSelection(files: FileLike[]): Set<string> {
  return new Set(files.filter((f) => f.isKey).map((f) => f.relPath));
}

/** 把当前勾选折算成相对默认值的增量 */
export function computeDelta(files: FileLike[], selected: Set<string>): SelDelta {
  const off: string[] = [];
  const on: string[] = [];
  for (const f of files) {
    const sel = selected.has(f.relPath);
    if (f.isKey && !sel) off.push(f.relPath);
    else if (!f.isKey && sel) on.push(f.relPath);
  }
  return { off, on };
}

/** 在默认勾选之上叠加增量，还原出完整勾选 */
export function applyDelta(files: FileLike[], delta: SelDelta | undefined): Set<string> {
  const selected = defaultSelection(files);
  if (!delta) return selected;
  const available = new Set(files.map((f) => f.relPath));
  for (const x of delta.off) selected.delete(x);
  // 存档里的 on 可能指向已删除的文件 → 只加还存在的
  for (const x of delta.on) {
    if (available.has(x)) selected.add(x);
  }
  return selected;
}

/**
 * 会话内重新扫描：保留用户仍然存在的勾选，并补上「这次新出现的关键文件」，
 * 避免一次 ↻ 把用户精挑细选的结果清空。
 */
export function mergeRescan(
  oldFiles: FileLike[],
  newFiles: FileLike[],
  selected: Set<string>
): Set<string> {
  const available = new Set(newFiles.map((f) => f.relPath));
  const before = new Set(oldFiles.map((f) => f.relPath));
  const next = new Set([...selected].filter((x) => available.has(x)));
  for (const f of newFiles) {
    if (f.isKey && !before.has(f.relPath)) next.add(f.relPath);
  }
  return next;
}

/**
 * 工具条批量操作。与 `App.tsx` 原先的内联实现逐字一致 ——
 * 抽出来是为了让设计预览也能复用同一份逻辑（复制一份必然会漂移）。
 */
export function bulkSelect(
  files: FileLike[],
  mode: BulkMode,
  selected: Set<string>
): Set<string> {
  switch (mode) {
    case "all":
      return new Set(files.map((f) => f.relPath));
    case "none":
      return new Set();
    case "key":
      return new Set(files.filter((f) => f.isKey).map((f) => f.relPath));
    case "invert":
      // 取反是「相对当前」的操作，必须读 selected
      return new Set(files.filter((f) => !selected.has(f.relPath)).map((f) => f.relPath));
  }
}

/**
 * 点分类 chip：该分类全选中 → 全取消；否则 → 全选中（三态语义）。
 *
 * 该分类下没有任何文件时**原样返回同一个 Set 引用**，
 * 调用方可据此判断「无需更新」，避免无意义的重渲染与 dirty 标记。
 */
export function toggleCategory(
  files: CategorizedFile[],
  cat: Category,
  selected: Set<string>
): Set<string> {
  const paths = files.filter((f) => f.category === cat).map((f) => f.relPath);
  if (paths.length === 0) return selected;
  const allOn = paths.every((x) => selected.has(x));
  const next = new Set(selected);
  for (const x of paths) {
    if (allOn) next.delete(x);
    else next.add(x);
  }
  return next;
}

/** 解析存档；损坏时返回空表而不是抛错（坏存档不该让应用打不开） */
export function parseSelMap(raw: string | null): SelMap {
  const out: SelMap = {};
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const d = value as { off?: unknown; on?: unknown };
    const pick = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    out[key] = { off: pick(d.off), on: pick(d.on) };
  }
  return out;
}

/** 参与勾选存档计算的一个项目快照（scan 为 null 表示扫描失败） */
export interface ArchiveEntry {
  root: string;
  scan: { files: FileLike[] } | null;
  selected: Set<string>;
}

/**
 * 由当前项目列表算出下一份勾选存档（App 写盘前的最后一步，纯函数）：
 * - 与默认值一致 → 不存（存储增量而非全量）
 * - 扫描失败的项目 → 保留上次的存档，不要动它
 * - 已被移除的项目 → 存档一并清掉
 *
 * scan 只声明用到的字段，与 ScanResult 结构兼容，测试时不必构造完整扫描结果。
 */
export function nextSelMap(prev: SelMap, entries: ArchiveEntry[]): SelMap {
  const next: SelMap = { ...prev };
  for (const p of entries) {
    if (!p.scan) continue; // 扫描失败的项目：保留上次的存档
    const key = p.root.toLowerCase();
    const delta = computeDelta(p.scan.files, p.selected);
    if (delta.off.length === 0 && delta.on.length === 0) {
      delete next[key]; // 与默认值一致 → 不必存
    } else {
      next[key] = delta;
    }
  }
  const alive = new Set(entries.map((p) => p.root.toLowerCase()));
  for (const k of Object.keys(next)) {
    if (!alive.has(k)) delete next[k];
  }
  return next;
}
