/**
 * 渲染冒烟测试 —— 把真实组件在 Node 里渲染成静态 HTML。
 *
 * 为什么需要它：`vite build` 成功只证明「能打包」，不证明「能渲染」。
 * 组件里一个未定义的 props 访问、一个空数组取下标，都会在运行时才炸。
 * 而 agent-browser 在本机（Windows）不可用，没法用浏览器兜这一层。
 *
 * `react-dom/server` 不需要浏览器，能在 CI / 命令行里跑，
 * 且走的是**真实的 render 路径** —— 组件抛异常就会在这里暴露。
 *
 * 断言只做「关键内容是否出现」，不做像素级比对（那会天天误报）。
 *
 * 运行：npm run verify:render
 */
import { renderToStaticMarkup } from "react-dom/server";
import ProjectCard from "../src/components/ProjectCard";
import ProjectManager from "../src/components/ProjectManager";
import Topbar from "../src/components/Topbar";
import { mkProject, mkProjects } from "../preview/mocks";
import type { ProjectEntry } from "../src/types";

let failures = 0;

/**
 * 断言要针对「人看到的文本」，而不是原始 HTML 字符串。
 * 两个坑：
 * 1. React 会在相邻文本节点间插 `<!-- -->`，把 `{a}/{b}` 拆开
 * 2. `{a}/{b}` 常被包成 `<b>220</b>/294`，标签又把文本切开
 * 所以先剥注释、再剥标签。反过来，**类名断言必须用原始 HTML**，
 * 否则剥掉标签后 "project-tree" 之类会永远找不到 → 假通过。
 */
const toText = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, "");

function mustContain(label: string, html: string, needles: string[]) {
  const text = toText(html);
  const missing = needles.filter((n) => !text.includes(n));
  const ok = missing.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        缺少: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
}

/** 针对原始 HTML（类名、属性）的「不应出现」断言 */
function mustNotContainRaw(label: string, html: string, needles: string[]) {
  const hit = needles.filter((n) => html.includes(n));
  const ok = hit.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        不该出现: ${hit.map((m) => JSON.stringify(m)).join(", ")}`);
}

/** 针对原始 HTML（类名、属性）的「应出现」断言 */
function mustContainRaw(label: string, html: string, needles: string[]) {
  const missing = needles.filter((n) => !html.includes(n));
  const ok = missing.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        缺少: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
}

/** 组件渲染抛异常时必须被捕获，否则整个脚本会带着栈信息崩掉、看不出是哪一项 */
function render(label: string, node: React.ReactElement): string {
  try {
    return renderToStaticMarkup(node);
  } catch (e) {
    failures += 1;
    console.log(`FAIL  ${label} —— 渲染抛出异常`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

const noop = () => {};

const projects = mkProjects();

// ---- 1. 管理页 ----
{
  const html = render(
    "管理页能渲染",
    <ProjectManager
      projects={projects}
      busy={null}
      onAdd={noop}
      onRescan={noop}
      onRescanAll={noop}
      onRemove={noop}
      onBulk={noop}
      onExportOne={noop}
      onOpen={noop}
    />
  );
  mustContain("管理页：表头与标题", html, [
    "已加载文件夹",
    "完整路径",
    "预估 token",
    "操作",
  ]);
  mustContain("管理页：三种状态都渲染出来", html, [
    "就绪",
    "扫描中…",
    "扫描失败",
  ]);
  mustContain("管理页：kind 徽章", html, ["TAURI", "NODE", "RUST"]);
  mustContain("管理页：项目名与合计行", html, [
    "tiez-clipboard-master",
    "合计",
  ]);
  // 错误项目的错误信息应当出现在 title 属性里，便于悬停查看
  mustContainRaw("管理页：错误详情进 title", html, ["目录不存在或不是文件夹"]);
}

// ---- 2. 管理页空态 ----
{
  const html = render(
    "管理页空态能渲染",
    <ProjectManager
      projects={[]}
      busy={null}
      onAdd={noop}
      onRescan={noop}
      onRescanAll={noop}
      onRemove={noop}
      onBulk={noop}
      onExportOne={noop}
      onOpen={noop}
    />
  );
  mustContain("管理页空态：提示与按钮", html, ["还没有加载任何文件夹", "添加文件夹"]);
}

// ---- 3. 卡片视图（就绪） ----
{
  const p = projects[0];
  const html = render(
    "卡片（就绪）能渲染",
    <ProjectCard
      project={p}
      query=""
      onToggleCollapse={noop}
      onRemove={noop}
      onRescan={noop}
      onSetSelected={noop}
      onBulk={noop}
      onToggleCategory={noop}
      onExportOne={noop}
    />
  );
  // 注意：卡片头部**没有**「就绪」文案（那是管理页才有的），
  // 就绪态在卡片上表现为统计信息。这里断言真实存在的东西。
  mustContain("卡片：项目名与路径", html, [p.name, p.root]);
  // 卡片头部本轮新增的 token 体量显示
  mustContain("卡片：显示预估 token", html, ["≈"]);
  mustContain("卡片：分类 chip 与工具条", html, [
    "Tauri 配置",
    "Rust 后端",
    "前端源码",
    "全选",
    "全不选",
    "仅关键",
    "反选",
  ]);
  mustContain("卡片：文件数统计", html, [`${p.selected.size}/${p.scan!.totalFiles}`]);
}

// ---- 4. 卡片：扫描失败 / 扫描中 不能崩 ----
{
  const err = mkProject("bad", "E:\\x\\bad", "unknown", 0, 0, 0, "error", "读不到目录");
  const html = render(
    "卡片（失败）能渲染",
    <ProjectCard
      project={err}
      query=""
      onToggleCollapse={noop}
      onRemove={noop}
      onRescan={noop}
      onSetSelected={noop}
      onBulk={noop}
      onToggleCategory={noop}
      onExportOne={noop}
    />
  );
  mustContain("卡片：失败态显示原因", html, ["扫描失败"]);

  const loading = mkProject("loading", "E:\\x\\loading", "unknown", 0, 0, 0, "loading");
  const html2 = render(
    "卡片（扫描中）能渲染",
    <ProjectCard
      project={loading}
      query=""
      onToggleCollapse={noop}
      onRemove={noop}
      onRescan={noop}
      onSetSelected={noop}
      onBulk={noop}
      onToggleCategory={noop}
      onExportOne={noop}
    />
  );
  mustContain("卡片：扫描中态", html2, ["扫描中…"]);
}

// ---- 5. 卡片：折叠时不应渲染文件树（大项目性能相关） ----
{
  const p: ProjectEntry = { ...projects[0], collapsed: true };
  const html = render(
    "卡片（折叠）能渲染",
    <ProjectCard
      project={p}
      query=""
      onToggleCollapse={noop}
      onRemove={noop}
      onRescan={noop}
      onSetSelected={noop}
      onBulk={noop}
      onToggleCategory={noop}
      onExportOne={noop}
    />
  );
  mustContainRaw("卡片：折叠标记", html, ["is-collapsed"]);
  mustNotContainRaw("卡片：折叠时不渲染文件树", html, ["project-tree"]);
}

// ---- 6. 全不选的项目：统计显示 0/M，且 token 为 0 ----
{
  const p = projects.find((x) => x.selected.size === 0 && x.status === "ready")!;
  const html = render(
    "卡片（未选任何文件）能渲染",
    <ProjectCard
      project={p}
      query=""
      onToggleCollapse={noop}
      onRemove={noop}
      onRescan={noop}
      onSetSelected={noop}
      onBulk={noop}
      onToggleCategory={noop}
      onExportOne={noop}
    />
  );
  mustContain("卡片：未选时统计为 0/M", html, [`0/${p.scan!.totalFiles}`]);
}

// ---- 7. 顶栏：视图差异（提取视图有折叠按钮；管理页没有；无项目时没有清空） ----
{
  const html = render(
    "顶栏（提取视图）能渲染",
    <Topbar
      view="extract"
      onView={noop}
      projectCount={3}
      busy={false}
      onAdd={noop}
      onAutoDetect={noop}
      onCollapseAll={noop}
      onExpandAll={noop}
      onShowShortcuts={noop}
      theme="system"
      onCycleTheme={noop}
      onClear={noop}
    />
  );
  mustContain("顶栏：品牌与两个 tab 及计数", html, [
    "Tauri 关键源码提取器",
    "提取",
    "已加载文件夹",
    "3",
  ]);
  mustContain("顶栏：提取视图显示折叠与清空", html, ["全部收起", "全部展开", "清空"]);
}
{
  const html = render(
    "顶栏（管理页视图、无项目）能渲染",
    <Topbar
      view="manage"
      onView={noop}
      projectCount={0}
      busy={false}
      onAdd={noop}
      onAutoDetect={noop}
      onCollapseAll={noop}
      onExpandAll={noop}
      onShowShortcuts={noop}
      theme="system"
      onCycleTheme={noop}
      onClear={noop}
    />
  );
  mustNotContainRaw("顶栏：管理页视图不显示折叠按钮", html, ["全部收起", "全部展开"]);
  mustNotContainRaw("顶栏：无项目时不显示清空", html, ["清空"]);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
