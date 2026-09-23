/**
 * 设计预览 harness —— 一个**可交互的迷你版应用**。
 *
 * 渲染的是真实组件 + 真实 styles.css + 真实 selection.ts 纯逻辑，
 * **只把 Tauri IPC 层换成内存 mock**。所以：
 * - 批量选择 / 分类 chip / 折叠 / 排序 / 筛选 / 移除，全都真的能点、真的生效
 * - 启用勾选、多选批量移除、侧边栏拖宽、设置面板也都能真点（状态与 App 同一套语义）
 * - 看到的效果与 App 里一致，不是手抄的静态 HTML（那种会随实现漂移）
 *
 * 用途：
 * 1. 改完样式立刻能看效果，不必启动整个 Tauri 应用
 * 2. 交互对不对可以**直接上手试**，不必靠文字描述互相想象
 * 3. 没有 Tauri 文件系统的场合（纯浏览器）这是唯一能跑通交互的路径
 *
 * 构建：npm run preview:design   （产物在 design-preview/）
 */
import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import BulkBar from "../src/components/BulkBar";
import PanelResizer from "../src/components/PanelResizer";
import ProjectCard from "../src/components/ProjectCard";
import ProjectManager from "../src/components/ProjectManager";
import SettingsModal from "../src/components/SettingsModal";
import {
  invertMark,
  toggleCategory,
  bulkSelect,
  type BulkMode,
} from "../src/selection";
import { projectStats } from "../src/stats";
import type { Category, ProjectEntry, UiSettings } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/types";
import { mkProject, mkProjects } from "./mocks";
import "../src/styles.css";

type View = "extract" | "manage";

/** 预览页自己的一句话说明，避免被误当成真实应用 */
function PreviewBanner() {
  return (
    <div className="preview-banner">
      <b>设计预览</b>
      <span>
        真实组件 + 真实样式 + 真实勾选逻辑，仅 Tauri 文件系统层为 mock。批量选择、分类
        chip、启用勾选、多选移除、拖宽侧边栏、设置面板都可以直接点。
      </span>
    </div>
  );
}

function PreviewApp() {
  const [projects, setProjects] = useState<ProjectEntry[]>(() => mkProjects());
  const [view, setView] = useState<View>("manage");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<UiSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const appRef = useRef<HTMLDivElement>(null);

  const patch = (id: string, fn: (p: ProjectEntry) => ProjectEntry) =>
    setProjects((prev) => prev.map((p) => (p.id === id ? fn(p) : p)));

  // ---- 与 App.tsx 同一套语义，只是少了 setDirty / 重新生成 ----

  const handleBulk = (id: string, mode: BulkMode) =>
    patch(id, (p) => ({
      ...p,
      selected: bulkSelect(p.scan?.files ?? [], mode, p.selected),
    }));

  const handleToggleCategory = (id: string, cat: Category) =>
    patch(id, (p) => {
      const next = toggleCategory(p.scan?.files ?? [], cat, p.selected);
      return next === p.selected ? p : { ...p, selected: next };
    });

  const handleSetSelected = (id: string, paths: string[], checked: boolean) =>
    patch(id, (p) => {
      const next = new Set(p.selected);
      for (const path of paths) {
        if (checked) next.add(path);
        else next.delete(path);
      }
      return { ...p, selected: next };
    });

  /** 启用/停用。mock 里所有项目都已带扫描结果，所以不触发真扫描 */
  const handleSetEnabled = (ids: string[], enabled: boolean) => {
    const set = new Set(ids);
    setProjects((prev) =>
      prev.map((p) =>
        set.has(p.id)
          ? {
              ...p,
              enabled,
              status: enabled ? (p.scan ? "ready" : "loading") : "idle",
              collapsed: enabled && settings.expandOnEnable ? false : p.collapsed,
            }
          : p
      )
    );
  };

  const markedIds = projects.filter((p) => p.marked).map((p) => p.id);
  const markedSet = new Set(markedIds);

  const handleSetMarked = (next: Set<string>) =>
    setProjects((prev) =>
      prev.map((p) => {
        const want = next.has(p.id);
        return want === p.marked ? p : { ...p, marked: want };
      })
    );

  /** 假重扫：走一遍 loading → ready，验证状态样式 */
  const handleRescan = (id: string) => {
    setBusy(id);
    patch(id, (p) => ({ ...p, status: "loading" }));
    window.setTimeout(() => {
      patch(id, (p) => ({ ...p, status: "ready", error: undefined }));
      setBusy(null);
    }, 900);
  };

  const say = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), settings.toastTtl || 3200);
  };

  const handleRemove = (id: string) =>
    setProjects((prev) => prev.filter((p) => p.id !== id));

  const handleRemoveMarked = () => {
    const set = markedSet;
    setProjects((prev) => prev.filter((p) => !set.has(p.id)));
    say(`已移除 ${set.size} 个文件夹（预览里不碰磁盘，真应用里同样只删列表）`);
  };

  const handleAdd = () => {
    const n = projects.length + 1;
    setProjects((prev) => [
      ...prev,
      mkProject(
        `new-project-${n}`,
        `E:\\E-Develop-Project\\new-project-${n}`,
        "node",
        40 + n * 7,
        20 + n * 3,
        2200,
        "ready",
        undefined,
        // 与 App 的 autoLoadLimit 同一套判断：一次加太多就不自动启用
        prev.length + 1 <= settings.autoLoadLimit
      ),
    ]);
  };

  const handleOpen = (id: string) => {
    setView("extract");
    handleSetEnabled([id], true);
    patch(id, (p) => ({ ...p, collapsed: false }));
  };

  const handleExportOne = (p: ProjectEntry) => {
    const st = projectStats(p.scan, p.selected);
    say(
      `导出 ${p.name}：${st.selected} 个文件，约 ${st.estTokens} tokens（预览里不真的写盘）`
    );
  };

  const ready = projects.filter((p) => p.status === "ready").length;
  const enabledList = projects.filter((p) => p.enabled);
  const enabledCount = enabledList.length;
  const enabledFiles = enabledList.reduce((s, p) => s + p.selected.size, 0);

  return (
    <div
      className="app"
      ref={appRef}
      style={{ "--left-w": `${settings.leftPanelWidth}px` } as CSSProperties}
    >
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
            className={`tab${view === "extract" ? " on" : ""}`}
            onClick={() => setView("extract")}
          >
            提取
            <span className="tab-count">{ready}</span>
          </button>
          <button
            className={`tab${view === "manage" ? " on" : ""}`}
            onClick={() => setView("manage")}
          >
            已加载文件夹
            <span className="tab-count">{projects.length}</span>
          </button>
        </nav>
        <div className="topbar-actions">
          <button className="btn primary" onClick={handleAdd}>
            + 添加项目
          </button>
          <button className="btn" onClick={handleAdd}>
            自动识别子项目
          </button>
          <button
            className="btn icon"
            onClick={() => setShowSettings(true)}
            title="设置（预览里不持久化）"
          >
            ⚙
          </button>
          <button className="btn" onClick={() => setProjects([])}>
            清空
          </button>
        </div>
      </header>

      {notice && <div className="hint-bar">{notice}</div>}
      <PreviewBanner />
      <BulkBar
        count={markedIds.length}
        needConfirm={settings.confirmBulkRemove}
        onRemove={handleRemoveMarked}
        onEnable={() => handleSetEnabled(markedIds, true)}
        onDisable={() => handleSetEnabled(markedIds, false)}
        onInvert={() =>
          handleSetMarked(invertMark(projects.map((p) => p.id), markedSet))
        }
        onClear={() => handleSetMarked(new Set())}
      />
      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={(p) => setSettings((s) => ({ ...s, ...p }))}
          onReset={() => setSettings(DEFAULT_SETTINGS)}
          onClose={() => setShowSettings(false)}
        />
      )}

      <main key={view} className={`body${view === "manage" ? " is-manage" : ""}`}>
        {view === "manage" ? (
          <ProjectManager
            projects={projects}
            busy={busy}
            marked={markedSet}
            onAdd={handleAdd}
            onRescan={handleRescan}
            onRescanAll={() =>
              projects.forEach((p) => {
                if (p.enabled && p.status !== "loading") handleRescan(p.id);
              })
            }
            onRemove={handleRemove}
            onSetMarked={handleSetMarked}
            onSetEnabled={handleSetEnabled}
            onBulk={handleBulk}
            onExportOne={handleExportOne}
            onOpen={handleOpen}
          />
        ) : (
          <>
            <section className="panel left">
              <div className="panel-head">
                <input
                  className="search"
                  placeholder="在所有项目里搜索文件路径…（预览里未接）"
                  disabled
                />
              </div>
              <div className="panel-scroll">
                {projects.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">📂</div>
                    <p>还没有项目</p>
                    <p className="muted">点右上角「+ 添加项目」加一个。</p>
                  </div>
                ) : (
                  <div className="project-list">
                    {projects.map((p) => (
                      <ProjectCard
                        key={p.id}
                        project={p}
                        query=""
                        marked={p.marked}
                        treeCollapseAt={settings.treeCollapseAt}
                        onToggleCollapse={() =>
                          patch(p.id, (x) => ({ ...x, collapsed: !x.collapsed }))
                        }
                        onToggleMark={() =>
                          handleSetMarked(
                            p.marked
                              ? new Set(
                                  projects.filter((x) => x.marked && x.id !== p.id).map((x) => x.id)
                                )
                              : new Set([...markedIds, p.id])
                          )
                        }
                        onSetEnabled={(enabled) => handleSetEnabled([p.id], enabled)}
                        onRemove={() => handleRemove(p.id)}
                        onRescan={() => handleRescan(p.id)}
                        onSetSelected={(paths, checked) =>
                          handleSetSelected(p.id, paths, checked)
                        }
                        onBulk={(mode) => handleBulk(p.id, mode)}
                        onToggleCategory={(cat) => handleToggleCategory(p.id, cat)}
                        onExportOne={() => handleExportOne(p)}
                      />
                    ))}
                  </div>
                )}
              </div>
              {projects.length > 0 && (
                <div className="panel-foot">
                  {projects.length} 个项目 · 启用 <b>{enabledCount}</b> · 已选{" "}
                  {enabledFiles} 个文件
                </div>
              )}
            </section>

            <PanelResizer
              width={settings.leftPanelWidth}
              targetRef={appRef}
              onCommit={(w) => setSettings((s) => ({ ...s, leftPanelWidth: w }))}
            />

            <section className="panel right">
              <div className="empty-state small">
                <p>预览 harness 未接入右侧导出面板</p>
                <p className="muted">
                  左侧拖这条分隔条可以调宽，双击复位，点住后用 ←/→。
                </p>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PreviewApp />);
