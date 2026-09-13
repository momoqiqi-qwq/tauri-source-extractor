import { useMemo } from "react";
import FileTree from "./FileTree";
import type { Category, ProjectEntry } from "../types";
import {
  BUDGET_TEXT,
  CATEGORY_META,
  CATEGORY_ORDER,
  KIND_META,
  estimateTokensFromBytes,
  formatBytes,
  formatNumber,
  formatTokensShort,
  shortPath,
} from "../types";
import { projectStats } from "../stats";

const ALL_CATEGORIES = new Set<Category>(CATEGORY_ORDER);

/** 单一真相源在 selection.ts，这里只是转出去给 ProjectManager 用 */
import type { BulkMode } from "../selection";
export type { BulkMode };

interface Props {
  project: ProjectEntry;
  query: string;
  onToggleCollapse: () => void;
  onRemove: () => void;
  onRescan: () => void;
  onSetSelected: (paths: string[], checked: boolean) => void;
  onBulk: (mode: BulkMode) => void;
  onToggleCategory: (cat: Category) => void;
  onExportOne: () => void;
}

export default function ProjectCard({
  project,
  query,
  onToggleCollapse,
  onRemove,
  onRescan,
  onSetSelected,
  onBulk,
  onToggleCategory,
  onExportOne,
}: Props) {
  const files = project.scan?.files ?? [];

  // 口径统一走 stats.ts（与顶栏总计、管理页表格同一份实现）
  const stats = useMemo(
    () => projectStats(project.scan, project.selected),
    [project.scan, project.selected]
  );

  const categoryCounts = useMemo(() => {
    const map = new Map<Category, { files: number; on: number; onBytes: number }>();
    for (const c of CATEGORY_ORDER) map.set(c, { files: 0, on: 0, onBytes: 0 });
    for (const f of files) {
      const e = map.get(f.category);
      if (!e) continue;
      e.files += 1;
      if (project.selected.has(f.relPath)) {
        e.on += 1;
        e.onBytes += f.size;
      }
    }
    return map;
  }, [files, project.selected]);

  const kind = KIND_META[project.kind] ?? KIND_META.unknown;

  // 卡片头部也标出本项目已选内容的 token 体量，与管理页、预算条同一套档位
  const { estTokens, tokenLevel } = stats;

  return (
    <div className={`project-card ${project.collapsed ? "is-collapsed" : ""}`}>
      <div className="project-head" onClick={onToggleCollapse}>
        <span className={`caret ${project.collapsed ? "closed" : ""}`}>▾</span>
        <span
          className="kind-badge"
          style={{ color: kind.color, borderColor: `${kind.color}55` }}
        >
          {kind.label}
        </span>
        <span className="project-name" title={project.name}>
          {project.name}
        </span>
        <span className="project-path" title={project.root}>
          {shortPath(project.root)}
        </span>

        {project.status === "loading" && (
          <span className="project-status loading">扫描中…</span>
        )}
        {project.status === "error" && (
          <span className="project-status err" title={project.error}>
            扫描失败
          </span>
        )}
        {project.status === "ready" && (
          <span className="project-stats">
            <b>{stats.selected}</b>/{stats.total} 文件 ·{" "}
            {formatNumber(stats.selLines)} 行 · {formatBytes(stats.selBytes)} ·{" "}
            <span className={`tok ${tokenLevel}`} title={BUDGET_TEXT[tokenLevel]}>
              ≈{formatTokensShort(estTokens)}
            </span>
          </span>
        )}

        <div className="project-actions" onClick={(e) => e.stopPropagation()}>
          <button className="mini" onClick={onRescan} title="重新扫描">
            ↻
          </button>
          <button className="mini" onClick={onExportOne} title="只导出本项目">
            导出
          </button>
          <button className="mini danger" onClick={onRemove} title="移除该项目">
            ✕
          </button>
        </div>
      </div>

      {!project.collapsed && (
        <div className="project-body">
          {project.status === "error" && (
            <div className="project-error">{project.error}</div>
          )}

          {project.status === "ready" && (
            <>
              <div className="project-toolbar">
                <button className="mini" onClick={() => onBulk("all")}>
                  全选
                </button>
                <button className="mini" onClick={() => onBulk("none")}>
                  全不选
                </button>
                <button className="mini" onClick={() => onBulk("key")}>
                  仅关键
                </button>
                <button className="mini" onClick={() => onBulk("invert")}>
                  反选
                </button>
                <div className="spacer" />
                <span className="muted tiny">
                  已忽略 {project.scan?.ignoredDirs.length ?? 0} 类目录
                </span>
              </div>

              <div className="cat-bar compact">
                {CATEGORY_ORDER.map((c) => {
                  const meta = CATEGORY_META[c];
                  const st = categoryCounts.get(c);
                  if (!st || st.files === 0) return null;
                  const allOn = st.on === st.files;
                  const some = st.on > 0 && !allOn;
                  return (
                    <button
                      key={c}
                      className={`cat-chip ${allOn ? "on" : some ? "some" : ""}`}
                      style={{
                        borderColor: `${meta.color}55`,
                        background: allOn ? meta.bg : "transparent",
                        color: meta.color,
                      }}
                      title={`点击${allOn ? "取消全选" : "全选"}「${meta.label}」`}
                      onClick={() => onToggleCategory(c)}
                    >
                      <span className="cat-dot" style={{ background: meta.color }} />
                      {meta.label}
                      <b>
                        {st.on}/{st.files}
                      </b>
                      {st.on > 0 && (
                        <i className="cat-tokens">
                          ≈{formatTokensShort(estimateTokensFromBytes(st.onBytes))}
                        </i>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="project-tree">
                <FileTree
                  files={files}
                  selected={project.selected}
                  onSetSelected={onSetSelected}
                  query={query}
                  activeCategories={ALL_CATEGORIES}
                  defaultCollapsed={files.length > 250}
                />
              </div>
            </>
          )}

          {project.status === "loading" && (
            <div className="project-loading">正在扫描 {project.root} …</div>
          )}
        </div>
      )}
    </div>
  );
}
