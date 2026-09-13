/**
 * localStorage 持久化 —— 项目列表、导出选项、勾选增量三项的读写都收在这里。
 *
 * 抽成独立模块的理由与 selection.ts 相同：这段逻辑出错是**静默**的
 * （存档悄悄丢、悄悄被默认值覆盖，不报错），值得单独一层的隔离与校验。
 * 纯逻辑（增量计算与存档合并）住在 selection.ts，由 verify:sel 直接校验；
 * 本模块只负责键名、序列化和 try/catch（隐私模式下 localStorage 可能不可用）。
 */
import type { ExtractOptions } from "./types";
import { parseSelMap, type SelMap } from "./selection";

export const ROOTS_KEY = "tse.roots.v2";
export const OPTIONS_KEY = "tse.options.v2";
export const SEL_KEY = "tse.sel.v3";
export const THEME_KEY = "tse.theme.v1";

/** 主题三态：跟随系统 / 强制亮 / 强制暗 */
export type ThemeMode = "system" | "light" | "dark";

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* ignore */
  }
}

/**
 * 把主题应用到 <html data-theme>。CSS 里只写一份 [data-theme="dark"] 覆盖块；
 * 「跟随系统」由 JS 监听 matchMedia 换算成明/暗再落到这里（见 App）。
 */
export function applyTheme(mode: ThemeMode): void {
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export const DEFAULT_OPTIONS: ExtractOptions = {
  format: "markdown",
  includeTree: true,
  includeMeta: true,
  header: "",
  maxFileKb: 512,
};

/** 读取上次的项目根目录列表；坏数据一律当作「没有存档」 */
export function loadRoots(): string[] {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    if (!raw) return [];
    const roots: unknown = JSON.parse(raw);
    return Array.isArray(roots)
      ? roots.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveRoots(roots: string[]): void {
  try {
    localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
  } catch {
    /* ignore */
  }
}

/** 读取导出选项，与默认值合并（存档缺字段时用默认值补齐） */
export function loadOptions(): ExtractOptions {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...DEFAULT_OPTIONS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_OPTIONS;
}

export function saveOptions(options: ExtractOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* ignore */
  }
}

/** 读取「勾选增量」存档（解析的纯逻辑在 selection.ts） */
export function readSelMap(): SelMap {
  try {
    return parseSelMap(localStorage.getItem(SEL_KEY));
  } catch {
    /* 隐私模式等场景下 localStorage 可能不可用 */
    return {};
  }
}

export function writeSelMap(next: SelMap): void {
  try {
    localStorage.setItem(SEL_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
