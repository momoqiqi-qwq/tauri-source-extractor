import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import BulkBar from "./components/BulkBar";
import PanelResizer from "./components/PanelResizer";
import ProjectCard from "./components/ProjectCard";
import ProjectManager from "./components/ProjectManager";
import SettingsModal from "./components/SettingsModal";
import Topbar from "./components/Topbar";
import ShortcutsModal from "./components/ShortcutsModal";
import {
  detectProjects,
  extForFormat,
  extractBundle,
  pickFolder,
  pickFolders,
  revealInFolder,
  saveTextFile,
  saveZipBundle,
  scanProject,
} from "./api";
import type {
  BundleResult,
  Category,
  ExtractOptions,
  ProjectEntry,
  ProjectKind,
  UiSettings,
} from "./types";
import {
  BUDGET_TEXT,
  budgetLevel,
  dateStamp,
  DEFAULT_SETTINGS,
  estimateTokensFromBytes,
  formatBytes,
  formatNumber,
} from "./types";
import {
  applyDelta,
  bulkSelect,
  invertMark,
  mergeRescan,
  nextSelMap,
  toggleCategory,
  type BulkMode,
} from "./selection";
import { usePresence } from "./motion";
import { projectStats } from "./stats";
import {
  applyTheme,
  loadOptions,
  loadRoots,
  loadSettings,
  loadTheme,
  readSelMap,
  saveOptions,
  saveRoots,
  saveSettings,
  saveTheme,
  writeSelMap,
  type RootRecord,
  type ThemeMode,
} from "./persistence";

const DEFAULT_HEADER = `你是一位资深 Tauri / Rust / React 工程师。下面是若干 Tauri 桌面项目的关键源码提取包。
请先通读，再根据我的问题作答；回答时请引用具体文件路径与函数名。`;

let uidCounter = 0;
function nextId(): string {
  uidCounter += 1;
  return `p_${Date.now().toString(36)}_${uidCounter}`;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** toast 内容：可选带一个动作按钮（如 zip 打包完成后的「打开文件夹」） */
interface ToastPayload {
  text: string;
  action?: { label: string; run: () => void };
}

export default function App() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ExtractOptions>(() => loadOptions());
  /** 界面偏好（时长 / 阈值 / 面板宽度），与发给后端的 ExtractOptions 分开 */
  const [settings, setSettings] = useState<UiSettings>(() => loadSettings());
  const [bundle, setBundle] = useState<BundleResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 弹层（toast / 错误横幅）统一走动效系统的 presence 生命周期：进 → 停 → 出
  // 停留时长来自设置，改完下一次弹层就生效（usePresence 的 show 依赖 ttl）
  const toastPres = usePresence<ToastPayload>(settings.toastTtl);
  const errorPres = usePresence<string>(settings.errorTtl);
  const flash = useCallback(
    (text: string, action?: ToastPayload["action"]) => toastPres.show({ text, action }),
    [toastPres.show]
  );
  const setError = errorPres.set;
  const [showHeaderEditor, setShowHeaderEditor] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** 主题三态：跟随系统 / 亮 / 暗（应用逻辑在 persistence.applyTheme） */
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  /** 主视图：extract = 挑文件 + 导出；manage = 已加载文件夹统管 */
  const [view, setView] = useState<"extract" | "manage">("extract");
  /** 有文件夹正被拖到窗口上 → 全窗遮罩提示 */
  const [dragOver, setDragOver] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 承载 --left-w 的容器，拖拽时由 PanelResizer 直接写 CSS 变量 */
  const appRef = useRef<HTMLDivElement>(null);

  const didInit = useRef(false);

  // ---------- 扫描 ----------

  const scanOne = useCallback(async (id: string, root: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: "loading", error: undefined } : p))
    );
    try {
      const res = await scanProject(root);
      // 本次会话首次扫描时，把上次退出前存下的「勾选增量」恢复回来。
      // 必须在写入 effect 之前读，否则会被刚算出的默认值覆盖。
      const saved = readSelMap()[root.toLowerCase()];
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          // 会话内重扫 → 保留用户勾选并补上新出现的关键文件；
          // 首次扫描 → 默认关键文件，再叠加上次退出前存下的增量
          const selected = p.scan
            ? mergeRescan(p.scan.files, res.files, p.selected)
            : applyDelta(res.files, saved);
          return {
            ...p,
            status: "ready",
            error: undefined,
            scan: res,
            name: res.projectName,
            kind: res.projectKind,
            selected,
          };
        })
      );
      setDirty(true);
    } catch (e) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, status: "error", error: String(e) } : p
        )
      );
    }
  }, []);

  /**
   * 新添加的文件夹要不要立刻读盘。
   *
   * 一次拖进来几十个文件夹时全部自动扫描，等于把「挑要看哪几个」的决定权
   * 从用户手里抢走，还要为此等上一轮 IO —— 所以超过阈值就只进列表，等勾选。
   */
  const toRecords = useCallback(
    (roots: string[]): RootRecord[] => {
      const auto = roots.length <= settings.autoLoadLimit;
      return roots.map((root) => ({ root, enabled: auto }));
    },
    [settings.autoLoadLimit]
  );

  const addRoots = useCallback(
    (items: RootRecord[]) => {
      const existing = new Set(projects.map((p) => p.root.toLowerCase()));
      const seen = new Set<string>();
      const fresh: RootRecord[] = [];
      for (const it of items) {
        const key = it.root.toLowerCase();
        if (existing.has(key) || seen.has(key)) continue;
        seen.add(key);
        fresh.push(it);
      }
      if (fresh.length === 0) {
        flash("这些文件夹已经在列表里了");
        return;
      }
      const added: ProjectEntry[] = fresh.map(({ root, enabled }) => ({
        id: nextId(),
        root,
        name: baseName(root),
        kind: "unknown" as ProjectKind,
        collapsed: false,
        status: enabled ? ("loading" as const) : ("idle" as const),
        scan: null,
        selected: new Set<string>(),
        enabled,
        marked: false,
      }));
      setProjects((prev) => [...prev, ...added]);
      for (const p of added) if (p.enabled) void scanOne(p.id, p.root);
      const off = added.filter((p) => !p.enabled).length;
      flash(
        off > 0
          ? `已添加 ${added.length} 个文件夹，勾选其中 ${off} 个才会扫描并加载文件树`
          : `已添加并加载 ${added.length} 个文件夹`
      );
    },
    [projects, scanOne, flash]
  );

  // 拖拽文件夹到窗口 = 添加项目。走 Tauri webview 的原生 drag-drop 事件
  //（浏览器设计预览里没有这层，事件不会触发，也不影响预览运行）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else if (event.payload.type === "leave") {
          setDragOver(false);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          if (event.payload.paths.length > 0) addRoots(toRecords(event.payload.paths));
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addRoots, toRecords]);

  // 首次加载：恢复上次的项目列表（读档细节在 persistence.ts）
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const records = loadRoots();
    if (records.length > 0) addRoots(records);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 持久化（读写与纯逻辑都在 persistence.ts）
  useEffect(() => {
    saveRoots(projects.map((p) => ({ root: p.root, enabled: p.enabled })));
  }, [projects]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveOptions(options);
  }, [options]);

  // 主题：模式持久化 + 应用到 <html>；跟随系统时监听系统切换实时变更
  useEffect(() => {
    saveTheme(theme);
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  /** 顶栏主题按钮：system → light → dark 循环 */
  const cycleTheme = useCallback(() => {
    setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"));
  }, []);

  // 持久化「勾选增量」。两个提前返回都是必须的，否则会把存档清空：
  //   1) 挂载初期 projects 还是空数组 —— 若继续往下走，alive 集合为空会把所有存档删掉
  //   2) 还有项目在扫描中 —— 此时 selected 还是默认值，写下去等于用默认值覆盖用户存档
  //
  // 注意这里传的是**完整的 projects**，不能按 enabled 过滤：nextSelMap 靠 alive 集合
  // 决定哪些存档该删，未启用（scan 为 null）的项目一旦不在列表里，它上次退出前的
  // 勾选就会被连带清掉 —— 由 verify:sel 的第 12 组断言锁住。
  useEffect(() => {
    if (projects.length === 0) return;
    if (projects.some((p) => p.status === "loading")) return;
    writeSelMap(nextSelMap(readSelMap(), projects));
  }, [projects]);

  // 导出选项（格式 / 目录树 / 统计 / 提示词 / 上限）变化同样要重生成，
  // 否则预览会停留在旧格式，看起来像「点了没反应」。跳过首次挂载。
  const optionsSignature = JSON.stringify(options);
  const lastOptionsRef = useRef(optionsSignature);
  useEffect(() => {
    if (lastOptionsRef.current === optionsSignature) return;
    lastOptionsRef.current = optionsSignature;
    setDirty(true);
  }, [optionsSignature]);

  // ---------- 选择 ----------

  const patchProject = useCallback(
    (id: string, fn: (p: ProjectEntry) => ProjectEntry) => {
      setProjects((prev) => prev.map((p) => (p.id === id ? fn(p) : p)));
    },
    []
  );

  /**
   * 启用 / 停用一批文件夹 —— 「勾选才加载」的落点。
   *
   * 停用不丢扫描结果：scan 留在内存里，再勾上立刻就有树，不必重扫。
   * 待扫描的清单在 updater 外面算：React 严格模式会把 updater 调两次，
   * 在里面收集副作用就会对同一个文件夹发起两次扫描。
   */
  const setEnabledFor = useCallback(
    (ids: string[], enabled: boolean) => {
      const idSet = new Set(ids);
      const targets = projects.filter((p) => idSet.has(p.id) && p.enabled !== enabled);
      setProjects((prev) =>
        prev.map((p) => {
          if (!idSet.has(p.id) || p.enabled === enabled) return p;
          const status = enabled
            ? // 有扫描结果 → 立刻就绪（不必重扫）；没有 → 交给下面的 scanOne
              p.scan
              ? "ready"
              : "loading"
            : p.status === "loading"
              ? "loading"
              : "idle";
          return {
            ...p,
            enabled,
            status,
            collapsed: enabled && settings.expandOnEnable ? false : p.collapsed,
          };
        })
      );
      if (enabled) {
        for (const p of targets) if (!p.scan) void scanOne(p.id, p.root);
      }
      setDirty(true);
    },
    [projects, settings.expandOnEnable, scanOne]
  );

  /** 多选集合存在每个 entry 上，这里只做整表对齐，保证只有一个真相 */
  const setMarked = useCallback((next: Set<string>) => {
    setProjects((prev) =>
      prev.map((p) => {
        const want = next.has(p.id);
        return want === p.marked ? p : { ...p, marked: want };
      })
    );
  }, []);

  const toggleMarkOne = useCallback((id: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, marked: !p.marked } : p))
    );
  }, []);

  const setSelectedFor = useCallback(
    (id: string, paths: string[], checked: boolean) => {
      patchProject(id, (p) => {
        const next = new Set(p.selected);
        for (const path of paths) {
          if (checked) next.add(path);
          else next.delete(path);
        }
        return { ...p, selected: next };
      });
      setDirty(true);
    },
    [patchProject]
  );

  const bulkSelectFor = useCallback(
    (id: string, mode: BulkMode) => {
      patchProject(id, (p) => ({
        ...p,
        // 纯逻辑在 selection.ts，与设计预览共用同一份实现
        selected: bulkSelect(p.scan?.files ?? [], mode, p.selected),
      }));
      setDirty(true);
    },
    [patchProject]
  );

  const toggleCategoryFor = useCallback(
    (id: string, cat: Category) => {
      patchProject(id, (p) => {
        const next = toggleCategory(p.scan?.files ?? [], cat, p.selected);
        // 该分类下没有文件时纯函数原样返回同一个引用 → 保持对象引用不变
        if (next === p.selected) return p;
        return { ...p, selected: next };
      });
      setDirty(true);
    },
    [patchProject]
  );

  const markedIds = useMemo(() => projects.filter((p) => p.marked).map((p) => p.id), [projects]);
  const markedSet = useMemo(() => new Set(markedIds), [markedIds]);

  const removeProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setDirty(true);
  }, []);

  /** 一键移除所有多选的文件夹。只删列表项，磁盘上的项目文件一律不动 */
  const removeMarked = useCallback(() => {
    if (markedIds.length === 0) return;
    const ids = new Set(markedIds);
    setProjects((prev) => prev.filter((p) => !ids.has(p.id)));
    setDirty(true);
    flash(`已移除 ${ids.size} 个文件夹（磁盘文件未改动）`);
  }, [markedIds, flash]);

  const toggleCollapse = useCallback(
    (id: string) => {
      patchProject(id, (p) => ({ ...p, collapsed: !p.collapsed }));
    },
    [patchProject]
  );

  const setAllCollapsed = useCallback((collapsed: boolean) => {
    // 未启用的卡片没有树可折叠，别把它们一起改了
    setProjects((prev) => prev.map((p) => (p.enabled ? { ...p, collapsed } : p)));
  }, []);

  /** 管理页点「打开」：启用该文件夹，切到提取页并展开 */
  const openProject = useCallback(
    (id: string) => {
      setEnabledFor([id], true);
      patchProject(id, (p) => ({ ...p, collapsed: false }));
      setView("extract");
    },
    [setEnabledFor, patchProject]
  );

  // ---------- 生成 ----------

  const selectedPayload = useMemo(
    () =>
      projects
        .filter((p) => p.enabled && p.scan && p.selected.size > 0)
        .map((p) => ({
          name: p.name,
          root: p.root,
          selected: Array.from(p.selected),
        })),
    [projects]
  );

  const generate = useCallback(async (): Promise<BundleResult | null> => {
    if (selectedPayload.length === 0) {
      setError(
        "还没有勾选任何文件。请在左侧项目里勾选文件，或点项目工具条上的「仅关键」。"
      );
      return null;
    }
    setBusy("extract");
    setError(null);
    try {
      const res = await extractBundle(selectedPayload, options);
      setBundle(res);
      setDirty(false);
      return res;
    } catch (e) {
      setError(String(e));
      setBundle(null);
      return null;
    } finally {
      setBusy(null);
    }
  }, [selectedPayload, options]);

  // 选择 / 扫描 / 选项变化后，自动重新生成（防抖），让预览始终是最新的。
  // 关掉设置里的 autoRegenerate 就只剩手动生成；防抖时长同样是设置项。
  useEffect(() => {
    if (!settings.autoRegenerate) return;
    if (!dirty || busy) return;
    if (selectedPayload.length === 0) return;
    if (projects.some((p) => p.status === "loading")) return;
    const t = window.setTimeout(() => {
      void generate();
    }, settings.regenDebounce);
    return () => window.clearTimeout(t);
  }, [dirty, busy, projects, selectedPayload, generate, settings.autoRegenerate, settings.regenDebounce]);

  const handleAdd = useCallback(async () => {
    try {
      const dirs = await pickFolders();
      if (dirs.length) addRoots(toRecords(dirs));
    } catch (e) {
      setError(String(e));
    }
  }, [addRoots, toRecords, setError]);

  const handleAutoDetect = useCallback(async () => {
    try {
      const dir = await pickFolder("选择包含多个项目的父目录");
      if (!dir) return;
      setBusy("detect");
      setError(null);
      const found = await detectProjects(dir, 3);
      if (found.length === 0) {
        setError(
          `「${dir}」下没有发现子项目。判据是目录里含 src-tauri/、package.json 或 Cargo.toml。`
        );
        return;
      }
      // 添加结果由 addRoots 统一播报（它才知道哪些被设成了未启用）
      addRoots(toRecords(found.map((f) => f.path)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [addRoots, toRecords, setError]);

  const handleExportOne = useCallback(
    async (p: ProjectEntry) => {
      if (!p.scan) return;
      if (p.selected.size === 0) {
        setError(`「${p.name}」还没有勾选任何文件`);
        return;
      }
      setBusy(`export:${p.id}`);
      setError(null);
      try {
        const res = await extractBundle(
          [{ name: p.name, root: p.root, selected: Array.from(p.selected) }],
          options
        );
        const saved = await saveTextFile(
          `${p.name}-source`,
          res.content,
          extForFormat(options.format)
        );
        if (saved) flash(`已保存到 ${saved}`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [options, flash]
  );

  const handleCopy = useCallback(async () => {
    // 勾选或选项变过（dirty）时先重生成，保证复制到的是最新内容
    const res = dirty || !bundle ? await generate() : bundle;
    if (!res) return;
    const content = res.content;
    try {
      await navigator.clipboard.writeText(content);
      flash("已复制到剪贴板");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = content;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flash("已复制到剪贴板");
    }
  }, [bundle, dirty, generate, flash]);

  const handleSave = useCallback(async () => {
    // 同理：dirty 时先重生成，避免保存到过期内容
    const res = dirty || !bundle ? await generate() : bundle;
    if (!res) return;
    const name =
      projects.length === 1
        ? `${projects[0].name}-source-${dateStamp()}`
        : `source-bundle-${projects.length}projects-${dateStamp()}`;
    try {
      const saved = await saveTextFile(name, res.content, extForFormat(options.format));
      if (saved) flash(`已保存到 ${saved}`);
    } catch (e) {
      setError(String(e));
    }
  }, [bundle, dirty, generate, projects, options.format, flash]);

  /** 一键把勾选的关键源码按原始目录结构打包成 zip（不走合并格式，直接读文件） */
  const handleSaveZip = useCallback(async () => {
    if (selectedPayload.length === 0) {
      setError(
        "还没有勾选任何文件。请在左侧项目里勾选文件，或点项目工具条上的「仅关键」。"
      );
      return;
    }
    setBusy("zip");
    setError(null);
    try {
      const stamp = dateStamp();
      const name =
        projects.length === 1
          ? `${projects[0].name}-key-source-${stamp}`
          : `key-source-${projects.length}projects-${stamp}`;
      const res = await saveZipBundle(name, selectedPayload);
      if (res) {
        const skipped = res.skipped.length > 0 ? `，跳过 ${res.skipped.length} 项` : "";
        flash(`已打包 ${res.fileCount} 个文件（${formatBytes(res.zipBytes)}）${skipped}`, {
          label: "打开文件夹",
          run: () => {
            revealInFolder(res.path).catch((e) => setError(String(e)));
          },
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [selectedPayload, projects, flash]);

  /** Ctrl+F / /：聚焦搜索框；在管理页时先切回提取视图 */
  const focusSearch = useCallback(() => {
    if (view !== "extract") setView("extract");
    // 切视图后 DOM 还没挂载，等一拍再聚焦
    window.setTimeout(() => searchRef.current?.focus(), 60);
  }, [view]);

  // 全局键盘快捷键。单键（/ 等）在输入框打字时不拦截；Ctrl 组合键不误伤输入
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === "Escape") {
        setShowShortcuts(false);
        setShowSettings(false);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        void generate();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void handleCopy();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        focusSearch();
      } else if (mod && e.key === "1") {
        e.preventDefault();
        setView("extract");
      } else if (mod && e.key === "2") {
        e.preventDefault();
        setView("manage");
      } else if (!mod && !typing && e.key === "/") {
        e.preventDefault();
        focusSearch();
      } else if (!mod && !typing && e.key === "?") {
        setShowShortcuts(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [generate, handleCopy, handleSave, focusSearch]);

  // 派生数据（口径统一走 stats.ts 的 projectStats，与卡片/管理页一致）
  // 只算启用的项目 —— 未启用不参与导出，计进来会让底部统计和预算条虚报体量

  const totals = useMemo(() => {
    let files = 0;
    let selected = 0;
    let selLines = 0;
    let selBytes = 0;
    let off = 0;
    for (const p of projects) {
      if (!p.enabled) {
        off += 1;
        continue;
      }
      const s = projectStats(p.scan, p.selected);
      files += s.total;
      selected += s.selected;
      selLines += s.selLines;
      selBytes += s.selBytes;
    }
    return {
      files,
      selected,
      selLines,
      selBytes,
      off,
      estTokens: estimateTokensFromBytes(selBytes),
    };
  }, [projects]);

  const level = budgetLevel(totals.estTokens);

  const previewText = useMemo(() => {
    if (!bundle) return "";
    const MAX = settings.previewLimit;
    if (bundle.content.length <= MAX) return bundle.content;
    return (
      bundle.content.slice(0, MAX) +
      `\n\n... [预览截断，完整内容 ${formatNumber(bundle.content.length)} 字符，请复制或保存查看] ...`
    );
  }, [bundle, settings.previewLimit]);

  const generating = busy === "extract";

  return (
    <div
      className="app"
      ref={appRef}
      /* 侧边栏宽度的落点：PanelResizer 拖拽时直接改写这个变量，松手才回写 state */
      style={{ "--left-w": `${settings.leftPanelWidth}px` } as CSSProperties}
    >
      <Topbar
        view={view}
        onView={setView}
        projectCount={projects.length}
        busy={busy !== null}
        onAdd={() => void handleAdd()}
        onAutoDetect={() => void handleAutoDetect()}
        onCollapseAll={() => setAllCollapsed(true)}
        onExpandAll={() => setAllCollapsed(false)}
        onShowShortcuts={() => setShowShortcuts(true)}
        onShowSettings={() => setShowSettings(true)}
        theme={theme}
        onCycleTheme={cycleTheme}
        onClear={() => {
          setProjects([]);
          setBundle(null);
          setDirty(false);
        }}
      />

      {errorPres.current && (
        <div
          key={errorPres.seq}
          className={`banner error${errorPres.current.leaving ? " is-leaving" : ""}`}
        >
          <span>{errorPres.current.value}</span>
          <button className="banner-close" onClick={() => errorPres.dismiss()}>
            ×
          </button>
        </div>
      )}
      {toastPres.current && (
        <div
          key={toastPres.seq}
          className={`toast${toastPres.current.leaving ? " is-leaving" : ""}`}
        >
          <span className="toast-text">{toastPres.current.value.text}</span>
          {toastPres.current.value.action && (
            <button
              className="toast-action"
              onClick={() => {
                const run = toastPres.current?.value.action?.run;
                toastPres.dismiss();
                run?.();
              }}
            >
              {toastPres.current.value.action.label}
            </button>
          )}
        </div>
      )}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-card">📂 松开鼠标，把这些文件夹添加为项目</div>
        </div>
      )}
      <BulkBar
        count={markedIds.length}
        needConfirm={settings.confirmBulkRemove}
        onRemove={removeMarked}
        onEnable={() => setEnabledFor(markedIds, true)}
        onDisable={() => setEnabledFor(markedIds, false)}
        onInvert={() => setMarked(invertMark(projects.map((p) => p.id), markedSet))}
        onClear={() => setMarked(new Set())}
      />
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          onReset={() => {
            setSettings(DEFAULT_SETTINGS);
            flash("已恢复默认设置");
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      <main key={view} className={`body ${view === "manage" ? "is-manage" : ""}`}>
        {view === "manage" ? (
          <ProjectManager
            projects={projects}
            busy={busy}
            marked={markedSet}
            onAdd={() => void handleAdd()}
            onRescan={(id) => {
              const p = projects.find((x) => x.id === id);
              if (p) void scanOne(p.id, p.root);
            }}
            onRescanAll={() => {
              // 未启用的不在此列：它们本来就没扫描过，等着被勾选而不是被重扫
              for (const p of projects) {
                if (p.enabled && p.status !== "loading") void scanOne(p.id, p.root);
              }
            }}
            onRemove={removeProject}
            onSetMarked={setMarked}
            onSetEnabled={setEnabledFor}
            onBulk={(id, mode) => bulkSelectFor(id, mode)}
            onExportOne={(p) => void handleExportOne(p)}
            onOpen={openProject}
          />
        ) : (
          <>
            <section className="panel left">
              <div className="panel-head">
                <input
                  ref={searchRef}
                  className="search"
                  placeholder="在所有项目里搜索文件路径…（Ctrl+F）"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="panel-scroll">
                {projects.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">📂</div>
                    <p>还没有项目</p>
                    <p className="muted">
                      点右上角「+ 添加项目」选一个或多个文件夹，
                      <br />
                      每个文件夹会被当成一个独立项目。
                      <br />
                      <br />
                      如果父目录下有一堆项目，直接点
                      <br />
                      「自动识别子项目」一次全加进来。
                    </p>
                  </div>
                ) : (
                  <>
                    {totals.off > 0 && totals.files === 0 && (
                      <div className="hint-bar">
                        {totals.off} 个文件夹待加载 —— 勾选行首的方框才会扫描并展开文件树。
                      </div>
                    )}
                    <div className="project-list">
                      {projects.map((p) => (
                        <ProjectCard
                          key={p.id}
                          project={p}
                          query={query}
                          marked={p.marked}
                          treeCollapseAt={settings.treeCollapseAt}
                          onToggleCollapse={() => toggleCollapse(p.id)}
                          onToggleMark={() => toggleMarkOne(p.id)}
                          onSetEnabled={(enabled) => setEnabledFor([p.id], enabled)}
                          onRemove={() => removeProject(p.id)}
                          onRescan={() => void scanOne(p.id, p.root)}
                          onSetSelected={(paths, checked) =>
                            setSelectedFor(p.id, paths, checked)
                          }
                          onBulk={(mode) => bulkSelectFor(p.id, mode)}
                          onToggleCategory={(cat) => toggleCategoryFor(p.id, cat)}
                          onExportOne={() => void handleExportOne(p)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
              {projects.length > 0 && (
                <div className="panel-foot">
                  {projects.length} 个项目
                  {totals.off > 0 && ` · 启用 ${projects.length - totals.off}`} · 已选{" "}
                  <b>{totals.selected}</b> / {totals.files} 个文件 ·{" "}
                  {formatNumber(totals.selLines)} 行 · {formatBytes(totals.selBytes)}
                </div>
              )}
            </section>

            <PanelResizer
              width={settings.leftPanelWidth}
              targetRef={appRef}
              onCommit={(w) => setSettings((s) => ({ ...s, leftPanelWidth: w }))}
            />

        <section className="panel right">
          <div className="options">
            <label className="opt">
              <span>格式</span>
              <select
                value={options.format}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    format: e.target.value as ExtractOptions["format"],
                  })
                }
              >
                <option value="markdown">Markdown（推荐）</option>
                <option value="xml">XML（类 repomix）</option>
                <option value="plain">纯文本</option>
              </select>
            </label>
            <label className="opt check">
              <input
                type="checkbox"
                checked={options.includeTree}
                onChange={(e) => setOptions({ ...options, includeTree: e.target.checked })}
              />
              <span>目录树</span>
            </label>
            <label className="opt check">
              <input
                type="checkbox"
                checked={options.includeMeta}
                onChange={(e) => setOptions({ ...options, includeMeta: e.target.checked })}
              />
              <span>统计信息</span>
            </label>
            <label className="opt">
              <span>单文件上限</span>
              <input
                type="number"
                className="num"
                min={1}
                value={options.maxFileKb}
                onChange={(e) =>
                  setOptions({ ...options, maxFileKb: Number(e.target.value) || 0 })
                }
              />
              <span className="unit">KB</span>
            </label>
            <button
              className={`btn ghost ${showHeaderEditor ? "active" : ""}`}
              onClick={() => {
                setShowHeaderEditor((v) => {
                  const next = !v;
                  if (next && !options.header) {
                    setOptions((o) => ({ ...o, header: DEFAULT_HEADER }));
                  }
                  return next;
                });
              }}
            >
              自定义提示词
            </button>
          </div>

          {showHeaderEditor && (
            <div className="header-editor">
              <textarea
                value={options.header}
                placeholder="放在提取包最前面的说明 / 提示词，可留空"
                onChange={(e) => setOptions({ ...options, header: e.target.value })}
                rows={4}
              />
              <button
                className="mini"
                onClick={() => setOptions({ ...options, header: DEFAULT_HEADER })}
              >
                用推荐模板
              </button>
            </div>
          )}

          {/* 上下文预算：导出包是喂给 AI 的，超窗口就白导了；key=档位，切换时重播弹入动画 */}
          <div
            key={level}
            className={`budget-row ${level}`}
            title="按已选文件的字节数估算，生成后以实际值为准"
          >
            <span className="budget-label">预估上下文</span>
            <span className="budget-value">≈ {formatNumber(totals.estTokens)} tokens</span>
            <span className="budget-scale">{BUDGET_TEXT[level]}</span>
          </div>

          <div className="action-bar">
            <button
              className="btn primary"
              onClick={() => void generate()}
              disabled={busy !== null || totals.selected === 0}
              title={
                totals.selected === 0
                  ? "请先勾选文件"
                  : "根据当前勾选生成提取包"
              }
            >
              {generating ? (
                <>
                  <span className="spinner" aria-hidden />
                  生成中…
                </>
              ) : dirty ? (
                "生成提取包 •"
              ) : (
                "生成提取包"
              )}
            </button>
            <button className="btn" onClick={() => void handleCopy()} disabled={busy !== null}>
              复制
            </button>
            <button className="btn" onClick={() => void handleSave()} disabled={busy !== null}>
              保存文件
            </button>
            <button
              className="btn"
              onClick={() => void handleSaveZip()}
              disabled={busy !== null || totals.selected === 0}
              title={
                totals.selected === 0
                  ? "请先勾选文件"
                  : "把当前勾选的关键源码按原始目录结构直接打包成 .zip（含二进制、保留路径；多项目时顶层目录为项目名）"
              }
            >
              {busy === "zip" ? (
                <>
                  <span className="spinner" aria-hidden />
                  打包中…
                </>
              ) : (
                "打包关键源码 (zip)"
              )}
            </button>
            <div className="spacer" />
            {bundle && (
              <div className="bundle-stats">
                <span>{bundle.projectCount} 项目</span>
                <span>{bundle.fileCount} 文件</span>
                <span>{formatNumber(bundle.totalLines)} 行</span>
                <span className="tokens">≈ {formatNumber(bundle.estTokens)} tokens</span>
              </div>
            )}
          </div>

          {totals.selected === 0 && projects.length > 0 && (
            <div className="hint-bar">
              还没有勾选任何文件 —— 展开左侧项目，点「仅关键」或直接勾选文件即可。
            </div>
          )}

          {totals.selected > 0 && level !== "ok" && (
            <div className={`hint-bar ${level === "over" ? "danger" : "warn"}`}>
              预估 ≈{formatNumber(totals.estTokens)} tokens（{BUDGET_TEXT[level]}）。
              用左侧分类 chip 关掉不需要的类别，或调低「单文件上限」把大文件剔掉，
              都能明显压下来。
            </div>
          )}

          <div className="preview-wrap">
            {bundle ? (
              <pre className="preview">{previewText}</pre>
            ) : (
              <div className="empty-state small">
                <p>
                  {busy === "extract"
                    ? "正在生成提取包…"
                    : "提取包预览会显示在这里"}
                </p>
              </div>
            )}
          </div>

          {bundle && bundle.skipped.length > 0 && (
            <div className="skipped">
              跳过 {bundle.skipped.length} 项：{bundle.skipped.slice(0, 3).join("；")}
              {bundle.skipped.length > 3 ? " …" : ""}
            </div>
          )}
        </section>
          </>
        )}
      </main>
    </div>
  );
}
