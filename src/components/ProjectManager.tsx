import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BulkMode } from "./ProjectCard";
import type { ProjectEntry } from "../types";
import { markAll, rangeMark } from "../selection";
import {
  BUDGET_TEXT,
  budgetLevel,
  estimateTokensFromBytes,
  formatNumber,
  formatTokensShort,
  KIND_META,
} from "../types";
import { projectStats, type ProjectStats } from "../stats";

interface Props {
  projects: ProjectEntry[];
  busy: string | null;
  /** 多选集合（与提取页卡片共用同一份，所以放在 App 里） */
  marked: Set<string>;
  /** 空态下的行动号召用；常态的「添加/自动识别/清空」在顶栏，避免重复 */
  onAdd: () => void;
  onRescan: (id: string) => void;
  /** 一键重扫所有文件夹（扫描中的跳过） */
  onRescanAll: () => void;
  onRemove: (id: string) => void;
  onSetMarked: (next: Set<string>) => void;
  onSetEnabled: (ids: string[], enabled: boolean) => void;
  onBulk: (id: string, mode: BulkMode) => void;
  onExportOne: (p: ProjectEntry) => void;
  onOpen: (id: string) => void;
}

interface Row extends ProjectStats {
  p: ProjectEntry;
  kindLabel: string;
  kindColor: string;
}

type SortKey = "name" | "path" | "files" | "lines" | "tokens" | "status";
/** null = 保持导入顺序 */
type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

/** 排序用的状态优先级：需要处理的排前面 */
const STATUS_RANK: Record<ProjectEntry["status"], number> = {
  error: 0,
  loading: 1,
  ready: 2,
  idle: 3,
};

function SortMark({ dir }: { dir: "asc" | "desc" | null }) {
  return (
    <span className={`sort-mark${dir ? " on" : ""}`}>
      {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}
    </span>
  );
}

/** 表头的全选框。部分选中要显示成横杠，只能摸 DOM 的 indeterminate */
function HeadMark({ state, onChange }: { state: "on" | "off" | "partial"; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "partial";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="tri"
      checked={state === "on"}
      onChange={onChange}
      title="多选当前可见的全部文件夹（行首圆点支持 Shift 成段选）"
    />
  );
}

/**
 * 「已加载文件夹」管理页：一屏看全所有导入的文件夹及其体量，并直接操作。
 *
 * 与左侧卡片视图的分工：卡片视图用来**挑文件**，这里用来**统管项目**——
 * 尤其是同时导入很多文件夹时，需要横向对比「谁最占 token」再决定裁哪个。
 */
export default function ProjectManager({
  projects,
  busy,
  marked,
  onAdd,
  onRescan,
  onRescanAll,
  onRemove,
  onSetMarked,
  onSetEnabled,
  onBulk,
  onExportOne,
  onOpen,
}: Props) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  /** Shift 点选的锚点，取上一次点击的行 id */
  const anchorRef = useRef<string | null>(null);

  /** 点表头：升序 → 降序 → 回到导入顺序 */
  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  const rows: Row[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = projects
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.root.toLowerCase().includes(q)
      )
      .map((p) => {
        const kind = KIND_META[p.kind] ?? KIND_META.unknown;
        return {
          p,
          // 与卡片视图 / 底部统计同一份实现（stats.ts）
          ...projectStats(p.scan, p.selected),
          kindLabel: kind.label,
          kindColor: kind.color,
        };
      });

    if (!sort) return list;

    const dir = sort.dir === "asc" ? 1 : -1;
    const pick = (r: Row): string | number => {
      switch (sort.key) {
        case "name":
          return r.p.name.toLowerCase();
        case "path":
          return r.p.root.toLowerCase();
        case "files":
          return r.selected;
        case "lines":
          return r.selLines;
        case "tokens":
          return r.estTokens;
        case "status":
          return STATUS_RANK[r.p.status];
      }
    };
    return [...list].sort((a, b) => {
      const va = pick(a);
      const vb = pick(b);
      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
  }, [projects, filter, sort]);

  const sortDir = (key: SortKey): "asc" | "desc" | null =>
    sort && sort.key === key ? sort.dir : null;

  /** 屏幕上可见、且已按当前排序排好的 id —— 全选与 Shift 区间都以它为准 */
  const visibleIds = useMemo(() => rows.map((r) => r.p.id), [rows]);

  const toggleMark = (id: string, shift: boolean) => {
    const anchor = anchorRef.current;
    anchorRef.current = id;
    if (shift && anchor) {
      onSetMarked(rangeMark(visibleIds, anchor, id, marked));
      return;
    }
    const next = new Set(marked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSetMarked(next);
  };

  const toggleAllMarked = () => onSetMarked(markAll(visibleIds, marked));

  const markedVisible = visibleIds.filter((id) => marked.has(id)).length;
  const markState: "on" | "off" | "partial" =
    markedVisible === 0
      ? "off"
      : markedVisible === visibleIds.length
        ? "on"
        : "partial";

  // 合计只算启用的行：未启用的文件夹没扫描、不参与导出，计进去等于虚报体量
  const grand = useMemo(() => {
    let total = 0;
    let selected = 0;
    let selLines = 0;
    let selBytes = 0;
    let off = 0;
    for (const r of rows) {
      if (!r.p.enabled) {
        off += 1;
        continue;
      }
      total += r.total;
      selected += r.selected;
      selLines += r.selLines;
      selBytes += r.selBytes;
    }
    return {
      total,
      selected,
      selLines,
      off,
      estTokens: estimateTokensFromBytes(selBytes),
    };
  }, [rows]);

  const grandLevel = budgetLevel(grand.estTokens);

  return (
    <div className="manager">
      <div className="manager-head">
        <div className="manager-title">
          已加载文件夹
          <b>{projects.length}</b>
          {filter && rows.length !== projects.length && (
            <span className="muted tiny">（筛选出 {rows.length}）</span>
          )}
        </div>
        <input
          className="search manager-search"
          placeholder="按名称或路径筛选…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="spacer" />
        <button
          className="mini"
          onClick={onRescanAll}
          disabled={busy !== null}
          title="重新扫描所有文件夹（改动过的文件、新增的关键文件会同步进来）"
        >
          全部重扫
        </button>
        <span className="muted tiny">
          启用 <b>{rows.length - grand.off}</b> / {rows.length}
          {grand.off > 0 && <span className="dim">（{grand.off} 个未启用）</span>} · 共{" "}
          {formatNumber(grand.total)} 文件 · 已选 {grand.selected} ·{" "}
          {formatNumber(grand.selLines)} 行
        </span>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📂</div>
          <p>还没有加载任何文件夹</p>
          <p className="muted">
            每个被导入的目录会被当成一个独立项目。
          </p>
          <button className="btn primary" onClick={onAdd} disabled={busy !== null}>
            + 添加文件夹
          </button>
        </div>
      ) : (
        <div className="manager-scroll">
          <table className="manager-table">
            <thead>
              <tr>
                <th className="col-mark" title="多选（用于批量启用/停用/移除）">
                  <HeadMark state={markState} onChange={toggleAllMarked} />
                </th>
                <th
                  className="col-name sortable"
                  onClick={() => toggleSort("name")}
                  title="按名称排序 · 行首方框 = 启用，勾选才会扫描并加载文件树"
                >
                  项目 <SortMark dir={sortDir("name")} />
                </th>
                <th className="col-path sortable" onClick={() => toggleSort("path")} title="按路径排序">
                  完整路径 <SortMark dir={sortDir("path")} />
                </th>
                <th className="num sortable" onClick={() => toggleSort("files")} title="按已选文件数排序">
                  文件 <SortMark dir={sortDir("files")} />
                </th>
                <th className="num sortable" onClick={() => toggleSort("lines")} title="按已选行数排序">
                  行数 <SortMark dir={sortDir("lines")} />
                </th>
                <th
                  className="num sortable"
                  onClick={() => toggleSort("tokens")}
                  title="按预估 token 排序 —— 降序即可找出最占地方的那个"
                >
                  预估 token <SortMark dir={sortDir("tokens")} />
                </th>
                <th className="col-status sortable" onClick={() => toggleSort("status")} title="按状态排序（异常优先）">
                  状态 <SortMark dir={sortDir("status")} />
                </th>
                <th className="col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="mgr-empty">
                    没有匹配「{filter}」的文件夹
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const level = budgetLevel(r.estTokens);
                const p = r.p;
                const on = p.enabled;
                return (
                  // --i 驱动 CSS 里的行级错峰淡入（styles.css 动效系统区块）
                  <tr
                    key={p.id}
                    className={`mgr-row ${on ? p.status : "off"}${on ? "" : " is-off"}`}
                    style={{ "--i": Math.min(i, 12) } as CSSProperties}
                  >
                    <td className="col-mark">
                      <button
                        className={`mark-dot${marked.has(p.id) ? " on" : ""}`}
                        aria-pressed={marked.has(p.id)}
                        aria-label="加入多选"
                        title="多选（Shift 点选成段）"
                        onClick={(e) => toggleMark(p.id, e.shiftKey)}
                      >
                        {marked.has(p.id) ? "✓" : ""}
                      </button>
                    </td>
                    <td className="col-name">
                      <input
                        type="checkbox"
                        className="enable-box"
                        checked={on}
                        onChange={(e) => onSetEnabled([p.id], e.target.checked)}
                        title={
                          on
                            ? "已启用：参与扫描、统计与导出。取消勾选可收回内存"
                            : "勾选后才会扫描这个文件夹并加载文件树"
                        }
                      />
                      <span
                        className="kind-badge"
                        style={{ color: r.kindColor, borderColor: `${r.kindColor}55` }}
                      >
                        {r.kindLabel}
                      </span>
                      <span className="mgr-name" title={p.name}>
                        {p.name}
                      </span>
                    </td>
                    <td className="col-path">
                      <span className="mgr-path" title={p.root}>
                        {p.root}
                      </span>
                    </td>
                    <td className="num">
                      {on ? (
                        <>
                          <b>{r.selected}</b> / {r.total}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">{on ? formatNumber(r.selLines) : "—"}</td>
                    <td className={`num tok ${on ? level : ""}`} title={BUDGET_TEXT[level]}>
                      {!on || r.total === 0 ? "—" : `≈ ${formatTokensShort(r.estTokens)}`}
                    </td>
                    <td className="col-status">
                      {!on && <span className="project-status off">未启用</span>}
                      {on && p.status === "loading" && (
                        <span className="project-status loading">扫描中…</span>
                      )}
                      {on && p.status === "error" && (
                        <span className="project-status err" title={p.error}>
                          扫描失败
                        </span>
                      )}
                      {on && p.status === "ready" && (
                        <span className="project-status ok">就绪</span>
                      )}
                    </td>
                    <td className="col-ops">
                      <div className="mgr-ops">
                        {!on ? (
                          <>
                            <button
                              className="mini primary"
                              onClick={() => onSetEnabled([p.id], true)}
                              disabled={busy !== null}
                              title="扫描并加载文件树"
                            >
                              启用
                            </button>
                            <button
                              className="mini danger"
                              onClick={() => onRemove(p.id)}
                              title="从列表移除（不删除磁盘文件）"
                            >
                              移除
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="mini"
                              onClick={() => onOpen(p.id)}
                              disabled={p.status !== "ready"}
                              title="切到提取页并展开这个文件夹"
                            >
                              打开
                            </button>
                            <button
                              className="mini"
                              onClick={() => onBulk(p.id, "key")}
                              disabled={p.status !== "ready"}
                              title="只勾选关键源码"
                            >
                              仅关键
                            </button>
                            <button
                              className="mini"
                              onClick={() => onBulk(p.id, "none")}
                              disabled={p.status !== "ready"}
                              title="全部取消勾选"
                            >
                              全不选
                            </button>
                            <button
                              className="mini"
                              onClick={() => onRescan(p.id)}
                              disabled={busy !== null}
                              title="重新扫描"
                            >
                              重扫
                            </button>
                            <button
                              className="mini"
                              onClick={() => onExportOne(p)}
                              disabled={busy !== null || p.selected.size === 0}
                              title="只导出这一个文件夹"
                            >
                              导出
                            </button>
                            <button
                              className="mini danger"
                              onClick={() => onRemove(p.id)}
                              title="从列表移除（不删除磁盘文件）"
                            >
                              移除
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td className="col-mark" />
                  <td className="col-name">合计</td>
                  <td className="col-path muted tiny">
                    {rows.length} 个文件夹{filter ? "（已筛选）" : ""}
                    {grand.off > 0 && ` · ${grand.off} 个未启用不计入`}
                  </td>
                  <td className="num">
                    <b>{grand.selected}</b> / {grand.total}
                  </td>
                  <td className="num">{formatNumber(grand.selLines)}</td>
                  <td className={`num tok ${grandLevel}`} title={BUDGET_TEXT[grandLevel]}>
                    ≈ {formatTokensShort(grand.estTokens)}
                  </td>
                  <td className="col-status" />
                  <td className="col-ops" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
