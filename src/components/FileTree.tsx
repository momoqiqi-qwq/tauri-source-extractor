import { useEffect, useMemo, useRef, useState } from "react";
import type { Category, FileEntry } from "../types";
import { CATEGORY_META, formatBytes } from "../types";

interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  file?: FileEntry;
  children: TreeNode[];
}

interface Props {
  files: FileEntry[];
  selected: Set<string>;
  onSetSelected: (paths: string[], checked: boolean) => void;
  query: string;
  activeCategories: Set<Category>;
  /** 文件很多时默认折叠目录，避免一次渲染上千行 */
  defaultCollapsed?: boolean;
}

function TriCheckbox({
  state,
  onChange,
}: {
  state: "on" | "off" | "partial";
  onChange: (next: boolean) => void;
}) {
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
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isFile: false, children: [] };
  for (const f of files) {
    const parts = f.relPath.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.children.find((c) => c.name === name && c.isFile === isLeaf);
      if (!next) {
        next = { name, path, isFile: isLeaf, children: [], file: isLeaf ? f : undefined };
        cur.children.push(next);
      }
      cur = next;
    }
  }
  const sortNode = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function collectFiles(node: TreeNode, out: FileEntry[] = []): FileEntry[] {
  if (node.isFile && node.file) out.push(node.file);
  node.children.forEach((c) => collectFiles(c, out));
  return out;
}

function collectDirPaths(node: TreeNode, out: string[] = []): string[] {
  if (!node.isFile) {
    node.children.forEach((c) => {
      if (!c.isFile) {
        out.push(c.path);
        collectDirPaths(c, out);
      }
    });
  }
  return out;
}

export default function FileTree({
  files,
  selected,
  onSetSelected,
  query,
  activeCategories,
  defaultCollapsed = false,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const initialized = useRef(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (!activeCategories.has(f.category)) return false;
      if (q && !f.relPath.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [files, query, activeCategories]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  // 文件很多时，首次渲染把目录折叠起来
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (defaultCollapsed) {
      setCollapsed(new Set(collectDirPaths(tree)));
    }
  }, [defaultCollapsed, tree]);

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (!node.isFile && node.children.length === 0) return null;

    if (node.isFile && node.file) {
      const f = node.file;
      const meta = CATEGORY_META[f.category];
      const checked = selected.has(f.relPath);
      return (
        <div
          key={node.path}
          className={`tree-row ${checked ? "checked" : ""}`}
          style={{ paddingLeft: depth * 14 + 8 }}
          title={f.relPath}
        >
          <TriCheckbox
            state={checked ? "on" : "off"}
            onChange={(next) => onSetSelected([f.relPath], next)}
          />
          <span className="tree-name">{node.name}</span>
          <span className="cat-dot" style={{ background: meta.color }} />
          <span className="tree-meta">
            {f.lines > 0 ? `${f.lines} 行 · ` : ""}
            {formatBytes(f.size)}
          </span>
          {f.isSecret && <span className="secret-tag">SECRET</span>}
        </div>
      );
    }

    const descendants = collectFiles(node);
    const allPaths = descendants.map((d) => d.relPath);
    const selCount = allPaths.filter((p) => selected.has(p)).length;
    const state: "on" | "off" | "partial" =
      allPaths.length === 0 || selCount === 0
        ? "off"
        : selCount === allPaths.length
          ? "on"
          : "partial";

    const isCollapsed = collapsed.has(node.path);
    const lines = descendants.reduce((s, d) => s + d.lines, 0);

    return (
      <div key={node.path}>
        <div
          className="tree-row dir"
          style={{ paddingLeft: depth * 14 + 8 }}
          onClick={() => toggleCollapse(node.path)}
        >
          <span className={`caret ${isCollapsed ? "closed" : ""}`}>▾</span>
          <TriCheckbox state={state} onChange={(next) => onSetSelected(allPaths, next)} />
          <span className="tree-name dir-name">{node.name}/</span>
          <span className="tree-meta">
            {descendants.length} 文件 · {lines} 行
          </span>
        </div>
        {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="tree">
      {filtered.length === 0 ? (
        <div className="empty-hint">没有匹配的文件</div>
      ) : (
        tree.children.map((c) => renderNode(c, 0))
      )}
    </div>
  );
}
