/**
 * localStorage 持久化 —— 项目列表、导出选项、勾选增量、界面偏好四项的读写都收在这里。
 *
 * 抽成独立模块的理由与 selection.ts 相同：这段逻辑出错是**静默**的
 * （存档悄悄丢、悄悄被默认值覆盖，不报错），值得单独一层的隔离与校验。
 * 纯逻辑（增量计算与存档合并）住在 selection.ts，由 verify:sel 直接校验；
 * 本模块只负责键名、序列化和 try/catch（隐私模式下 localStorage 可能不可用）。
 */
import type { ExtractOptions, UiSettings } from "./types";
// 带 .ts 后缀是为了让 Node 版校验脚本（verify:persist）能直接 import 本模块；
// 纯类型导入会被擦掉所以不用写，值导入必须写全。
import { clampPanelWidth, DEFAULT_SETTINGS } from "./types.ts";
import { parseSelMap, type SelMap } from "./selection.ts";

export const ROOTS_KEY = "tse.roots.v3";
/** v2 存的是纯路径数组，没有「是否启用」概念，需要迁移 */
const ROOTS_KEY_V2 = "tse.roots.v2";
export const OPTIONS_KEY = "tse.options.v2";
export const SEL_KEY = "tse.sel.v3";
export const THEME_KEY = "tse.theme.v1";
export const SETTINGS_KEY = "tse.settings.v1";

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

/** 存档里的一条项目记录：路径 + 上次退出时是否处于启用状态 */
export interface RootRecord {
  root: string;
  enabled: boolean;
}

/** 读取上次的项目根目录列表；坏数据一律当作「没有存档」 */
export function loadRoots(): RootRecord[] {
  try {
    const raw = localStorage.getItem(ROOTS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: RootRecord[] = [];
      for (const item of parsed) {
        // 兼容两种形状：v3 的 {root, enabled} 与手改存档里残留的纯字符串
        if (typeof item === "string") {
          out.push({ root: item, enabled: false });
        } else if (item && typeof item === "object") {
          const r = item as { root?: unknown; enabled?: unknown };
          if (typeof r.root === "string") {
            out.push({ root: r.root, enabled: r.enabled === true });
          }
        }
      }
      return out;
    }
    // 老存档：只有路径。一律按「未启用」恢复 —— 新模型下没人勾选过的东西不该自动读盘
    const legacy = localStorage.getItem(ROOTS_KEY_V2);
    if (!legacy) return [];
    const parsed: unknown = JSON.parse(legacy);
    return Array.isArray(parsed)
      ? parsed
          .filter((r): r is string => typeof r === "string")
          .map((root) => ({ root, enabled: false }))
      : [];
  } catch {
    return [];
  }
}

export function saveRoots(roots: RootRecord[]): void {
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

/**
 * 数值项：坏值（NaN / null / 布尔 / 对象 / 越界）回落默认值，再钳进合法区间。
 *
 * 不能直接 `Number(raw)` —— null、""、false、[] 全都会被安静地转成 0，
 * 而 0 在这份设置里是有意义的（toastTtl=0 表示"永不自动关闭"），
 * 一个损坏的存档字段就会让弹层再也不消失。
 */
function readNum(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(max, Math.max(min, Math.round(raw)));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(max, Math.max(min, Math.round(n)));
  }
  return fallback;
}

function readBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * 读取界面偏好。逐字段过一遍而不是 `{...默认, ...存档}`：
 * 存档可能被旧版本写过、也可能被手改坏，一个 `"toastTtl": "abc"` 混进去
 * 会让 setTimeout 立刻触发（NaN），弹层一闪就没 —— 那种 bug 极难查。
 */
export function loadSettings(): UiSettings {
  let raw: Record<string, unknown> = {};
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const d = DEFAULT_SETTINGS;
  return {
    toastTtl: readNum(raw.toastTtl, d.toastTtl, 0, 60_000),
    errorTtl: readNum(raw.errorTtl, d.errorTtl, 0, 60_000),
    autoLoadLimit: readNum(raw.autoLoadLimit, d.autoLoadLimit, 0, 500),
    expandOnEnable: readBool(raw.expandOnEnable, d.expandOnEnable),
    treeCollapseAt: readNum(raw.treeCollapseAt, d.treeCollapseAt, 20, 5000),
    autoRegenerate: readBool(raw.autoRegenerate, d.autoRegenerate),
    regenDebounce: readNum(raw.regenDebounce, d.regenDebounce, 0, 5000),
    previewLimit: readNum(raw.previewLimit, d.previewLimit, 1_000, 5_000_000),
    leftPanelWidth: clampPanelWidth(
      readNum(raw.leftPanelWidth, d.leftPanelWidth, 0, 10_000),
    ),
    confirmBulkRemove: readBool(raw.confirmBulkRemove, d.confirmBulkRemove),
  };
}

export function saveSettings(settings: UiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
