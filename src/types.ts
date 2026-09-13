export type Category =
  | "tauri-config"
  | "rust"
  | "frontend"
  | "data"
  | "config"
  | "docs"
  | "env"
  | "other";

export type ProjectKind = "tauri" | "node" | "rust" | "unknown";

export interface FileEntry {
  relPath: string;
  absPath: string;
  name: string;
  dir: string;
  ext: string;
  category: Category;
  size: number;
  lines: number;
  isKey: boolean;
  isText: boolean;
  isSecret: boolean;
}

export interface CategoryStat {
  category: Category;
  files: number;
  bytes: number;
  lines: number;
}

export interface ScanResult {
  root: string;
  projectName: string;
  projectKind: ProjectKind;
  files: FileEntry[];
  stats: CategoryStat[];
  totalFiles: number;
  totalBytes: number;
  totalLines: number;
  ignoredDirs: string[];
}

export interface DetectedProject {
  name: string;
  path: string;
  kind: ProjectKind;
}

export interface ExtractOptions {
  format: "markdown" | "xml" | "plain";
  includeTree: boolean;
  includeMeta: boolean;
  header: string;
  maxFileKb: number;
}

export interface ProjectBrief {
  name: string;
  fileCount: number;
  lines: number;
  estTokens: number;
}

export interface BundleResult {
  content: string;
  fileCount: number;
  projectCount: number;
  totalLines: number;
  totalChars: number;
  estTokens: number;
  skipped: string[];
  perProject: ProjectBrief[];
  generatedAt: string;
}

export interface ZipProjectBrief {
  name: string;
  fileCount: number;
  bytes: number;
}

/** extract_zip 的返回：勾选的源码被原样打包成 zip */
export interface ZipResult {
  /** 写出的 zip 完整路径 */
  path: string;
  fileCount: number;
  projectCount: number;
  /** 解压后的原始字节数 */
  totalBytes: number;
  /** zip 文件本身的大小 */
  zipBytes: number;
  skipped: string[];
  perProject: ZipProjectBrief[];
  generatedAt: string;
}

/** 左侧列表里的一个项目 */
export interface ProjectEntry {
  id: string;
  root: string;
  name: string;
  kind: ProjectKind;
  collapsed: boolean;
  status: "loading" | "ready" | "error";
  error?: string;
  scan: ScanResult | null;
  selected: Set<string>;
}

export const CATEGORY_META: Record<
  Category,
  { label: string; color: string; bg: string }
> = {
  "tauri-config": { label: "Tauri 配置", color: "#b45309", bg: "#fef3c7" },
  rust: { label: "Rust 后端", color: "#b91c1c", bg: "#fee2e2" },
  frontend: { label: "前端源码", color: "#1d4ed8", bg: "#dbeafe" },
  data: { label: "数据/迁移", color: "#047857", bg: "#d1fae5" },
  config: { label: "配置文件", color: "#0f766e", bg: "#ccfbf1" },
  docs: { label: "文档", color: "#6d28d9", bg: "#ede9fe" },
  env: { label: "环境变量", color: "#be123c", bg: "#ffe4e6" },
  other: { label: "其他", color: "#4b5563", bg: "#e5e7eb" },
};

export const CATEGORY_ORDER: Category[] = [
  "tauri-config",
  "rust",
  "frontend",
  "data",
  "config",
  "docs",
  "env",
  "other",
];

export const KIND_META: Record<ProjectKind, { label: string; color: string }> = {
  tauri: { label: "TAURI", color: "#b45309" },
  node: { label: "NODE", color: "#1d4ed8" },
  rust: { label: "RUST", color: "#b91c1c" },
  unknown: { label: "OTHER", color: "#6b7280" },
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** 今天日期的紧凑串（如 20260914），拼进导出文件名，方便按日期归档 */
export function dateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 紧凑的 token 数：1234 → 1.2k，320000 → 320k */
export function formatTokensShort(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** 上下文预算档位：ok ≤128k，warn ≤256k，over >256k */
export type BudgetLevel = "ok" | "warn" | "over";

export function budgetLevel(tokens: number): BudgetLevel {
  if (tokens > 256_000) return "over";
  if (tokens > 128_000) return "warn";
  return "ok";
}

export const BUDGET_TEXT: Record<BudgetLevel, string> = {
  ok: "在 128k 舒适区内",
  warn: "已超过 128k，偏大",
  over: "已超过 256k，多数模型放不下",
};

/**
 * 按字节数近似估算 token。
 *
 * 后端用的是「实际字符数 / 3.6」，这里拿不到字符数，只有扫描时的字节数；
 * 对以 ASCII 为主的代码两者几乎相等，含中文时字节数偏大 → 估算偏保守（更早报警）。
 */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 3.6);
}

export function shortPath(p: string, max = 52): string {
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/);
  if (parts.length <= 2) return `…${p.slice(-max)}`;
  return `${parts[0]}…${parts.slice(-2).join("/")}`;
}
