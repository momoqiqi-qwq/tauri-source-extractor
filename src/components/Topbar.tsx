interface Props {
  view: "extract" | "manage";
  onView: (v: "extract" | "manage") => void;
  projectCount: number;
  /** 任一异步操作进行中 → 顶栏动作全部禁用 */
  busy: boolean;
  onAdd: () => void;
  onAutoDetect: () => void;
  /** 仅提取视图显示（管理页是表格，没有折叠概念） */
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onShowShortcuts: () => void;
  onShowSettings: () => void;
  /** 主题三态与循环切换（system → light → dark） */
  theme: "system" | "light" | "dark";
  onCycleTheme: () => void;
  onClear: () => void;
}

const THEME_META = {
  system: { icon: "◐", label: "跟随系统" },
  light: { icon: "☀", label: "亮色" },
  dark: { icon: "☾", label: "暗色" },
} as const;

/** 顶栏：品牌、视图切换、全局动作。纯展示组件，状态与回调都在 App。 */
export default function Topbar({
  view,
  onView,
  projectCount,
  busy,
  onAdd,
  onAutoDetect,
  onCollapseAll,
  onExpandAll,
  onShowShortcuts,
  onShowSettings,
  theme,
  onCycleTheme,
  onClear,
}: Props) {
  const themeMeta = THEME_META[theme];
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">TS</div>
        <div className="brand-text">
          <div className="title">Tauri 关键源码提取器</div>
          <div className="subtitle">多项目 · 分类勾选 · 合并导出喂给 AI</div>
        </div>
      </div>
      <nav className="tabs">
        <button
          className={`tab ${view === "extract" ? "on" : ""}`}
          onClick={() => onView("extract")}
        >
          提取
        </button>
        <button
          className={`tab ${view === "manage" ? "on" : ""}`}
          onClick={() => onView("manage")}
        >
          已加载文件夹
          {projectCount > 0 && <span className="tab-count">{projectCount}</span>}
        </button>
      </nav>
      <div className="topbar-actions">
        <button className="btn primary" onClick={onAdd} disabled={busy}>
          + 添加项目
        </button>
        <button className="btn" onClick={onAutoDetect} disabled={busy} title="选择一个父目录，自动发现里面所有的 Tauri / Node / Rust 项目">
          自动识别子项目
        </button>
        {/* 收起/展开只对卡片视图有意义，管理页是表格 */}
        {view === "extract" && (
          <>
            <button className="btn" onClick={onCollapseAll} disabled={projectCount === 0}>
              全部收起
            </button>
            <button className="btn" onClick={onExpandAll} disabled={projectCount === 0}>
              全部展开
            </button>
          </>
        )}
        <button
          className="btn icon"
          onClick={onCycleTheme}
          aria-label={`主题：${themeMeta.label}，点击切换`}
          title={`主题：${themeMeta.label}（点击切换 跟随系统 → 亮色 → 暗色）`}
        >
          {themeMeta.icon}
        </button>
        <button
          className="btn icon"
          onClick={onShowShortcuts}
          aria-label="键盘快捷键"
          title="键盘快捷键（随时按 ? 呼出）"
        >
          ⌨
        </button>
        <button
          className="btn icon"
          onClick={onShowSettings}
          aria-label="设置"
          title="设置（Ctrl+,）：提醒时长、加载行为、预览上限等"
        >
          ⚙
        </button>
        {projectCount > 0 && (
          <button className="btn" onClick={onClear} title="清空项目列表（不会删除磁盘文件）">
            清空
          </button>
        )}
      </div>
    </header>
  );
}
