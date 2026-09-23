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
import BulkBar from "../src/components/BulkBar";
import PanelResizer from "../src/components/PanelResizer";
import ProjectCard from "../src/components/ProjectCard";
import ProjectManager from "../src/components/ProjectManager";
import SettingsModal from "../src/components/SettingsModal";
import Topbar from "../src/components/Topbar";
import { mkProject, mkProjects } from "../preview/mocks";
import type { ProjectEntry, UiSettings } from "../src/types";
import { DEFAULT_SETTINGS } from "../src/types";

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

/** 针对可见文本的「不应出现」断言（剥标签后比对，理由见 toText） */
function mustNotContain(label: string, html: string, needles: string[]) {
  const text = toText(html);
  const hit = needles.filter((n) => text.includes(n));
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

/**
 * 组件公共 props 工厂。
 *
 * 这几个组件的必填 props 会随功能一路增加，同一个 props 块手抄 5 遍必然漏改
 * （漏了就是一片 TS 报错或者假通过）。集中一份，加 props 只改这里。
 */
const cardProps = (project: ProjectEntry) => ({
  project,
  query: "",
  marked: false,
  treeCollapseAt: DEFAULT_SETTINGS.treeCollapseAt,
  onToggleCollapse: noop,
  onToggleMark: noop,
  onSetEnabled: noop,
  onRemove: noop,
  onRescan: noop,
  onSetSelected: noop,
  onBulk: noop,
  onToggleCategory: noop,
  onExportOne: noop,
});

const managerProps = (list: ProjectEntry[]) => ({
  projects: list,
  busy: null,
  marked: new Set<string>(),
  onAdd: noop,
  onRescan: noop,
  onRescanAll: noop,
  onRemove: noop,
  onSetMarked: noop,
  onSetEnabled: noop,
  onBulk: noop,
  onExportOne: noop,
  onOpen: noop,
});

const topbarProps = {
  view: "extract" as const,
  onView: noop,
  projectCount: 3,
  busy: false,
  onAdd: noop,
  onAutoDetect: noop,
  onCollapseAll: noop,
  onExpandAll: noop,
  onShowShortcuts: noop,
  onShowSettings: noop,
  theme: "system" as const,
  onCycleTheme: noop,
  onClear: noop,
};

// ---- 1. 管理页 ----
{
  const html = render(
    "管理页能渲染",
    <ProjectManager {...managerProps(projects)} />
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
    <ProjectManager {...managerProps([])} />
  );
  mustContain("管理页空态：提示与按钮", html, ["还没有加载任何文件夹", "添加文件夹"]);
}

// ---- 3. 卡片视图（就绪） ----
{
  const p = projects[0];
  const html = render(
    "卡片（就绪）能渲染",
    <ProjectCard {...cardProps(p)} />
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
    <ProjectCard {...cardProps(err)} />
  );
  mustContain("卡片：失败态显示原因", html, ["扫描失败"]);

  const loading = mkProject("loading", "E:\\x\\loading", "unknown", 0, 0, 0, "loading");
  const html2 = render(
    "卡片（扫描中）能渲染",
    <ProjectCard {...cardProps(loading)} />
  );
  mustContain("卡片：扫描中态", html2, ["扫描中…"]);
}

// ---- 5. 卡片：折叠时不应渲染文件树（大项目性能相关） ----
{
  const p: ProjectEntry = { ...projects[0], collapsed: true };
  const html = render(
    "卡片（折叠）能渲染",
    <ProjectCard {...cardProps(p)} />
  );
  mustContainRaw("卡片：折叠标记", html, ["is-collapsed"]);
  mustNotContainRaw("卡片：折叠时不渲染文件树", html, ["project-tree"]);
}

// ---- 6. 全不选的项目：统计显示 0/M，且 token 为 0 ----
{
  const p = projects.find((x) => x.selected.size === 0 && x.status === "ready")!;
  const html = render(
    "卡片（未选任何文件）能渲染",
    <ProjectCard {...cardProps(p)} />
  );
  mustContain("卡片：未选时统计为 0/M", html, [`0/${p.scan!.totalFiles}`]);
}

// ---- 7. 顶栏：视图差异（提取视图有折叠按钮；管理页没有；无项目时没有清空） ----
{
  const html = render(
    "顶栏（提取视图）能渲染",
    <Topbar {...topbarProps} />
  );
  mustContain("顶栏：品牌与两个 tab 及计数", html, [
    "Tauri 关键源码提取器",
    "提取",
    "已加载文件夹",
    "3",
  ]);
  mustContain("顶栏：提取视图显示折叠与清空", html, ["全部收起", "全部展开", "清空"]);
  mustContainRaw("顶栏：设置入口", html, ["aria-label=\"设置\""]);
}
{
  const html = render(
    "顶栏（管理页视图、无项目）能渲染",
    <Topbar {...topbarProps} view="manage" projectCount={0} />
  );
  mustNotContainRaw("顶栏：管理页视图不显示折叠按钮", html, ["全部收起", "全部展开"]);
  mustNotContainRaw("顶栏：无项目时不显示清空", html, ["清空"]);
}

// ---- 8. 未启用的卡片：不扫描、不渲染树、不显示统计 ----
{
  const off = projects.find((p) => !p.enabled)!;
  const html = render("卡片（未启用）能渲染", <ProjectCard {...cardProps(off)} />);
  mustContain("卡片：未启用显示状态标签", html, ["未启用"]);
  // 这条断言是「勾选才加载」的核心：未启用时整棵文件树连工具条、分类 chip 都不该出现，
  // 否则一次导入几十个文件夹就会把上万行 DOM 全挂上去。
  mustNotContainRaw("卡片：未启用时不渲染文件树与工具条", html, [
    "project-tree",
    "project-toolbar",
    "cat-chip",
  ]);
  // 有扫描结果也不该把体量报出来（它不参与导出）
  mustNotContain("卡片：未启用时不显示文件数统计", html, ["文件 ·"]);
  mustContain("卡片：未启用时给出启用入口", html, ["启用"]);
}

// ---- 9. 管理页：未启用行的呈现 ----
{
  const html = render("管理页（含未启用行）能渲染", <ProjectManager {...managerProps(projects)} />);
  mustContain("管理页：未启用状态与启用按钮", html, ["未启用", "启用"]);
  // title 与 value 都是属性，必须走原始 HTML 断言（toText 会把属性一起剥掉）
  mustContainRaw("管理页：表头多选框", html, ['title="多选（用于批量启用/停用/移除）"']);
  mustContainRaw("管理页：未启用行带 is-off 类", html, ["is-off"]);
  // 合计行必须说明未启用不计入，否则用户会拿合计去对账
  mustContain("管理页：合计行标注未启用个数", html, ["个未启用不计入"]);
}

// ---- 10. 设置面板：每个分组与关键项都要出现 ----
{
  const html = render(
    "设置面板能渲染",
    <SettingsModal
      settings={DEFAULT_SETTINGS}
      onChange={noop}
      onReset={noop}
      onClose={noop}
    />
  );
  mustContain("设置：四个分组", html, ["提醒", "加载行为", "导出与预览", "界面"]);
  mustContain("设置：用户点名的提示停留时长", html, ["提示停留时长", "提取、保存、打包完成后那条提示显示多久"]);
  mustContain("设置：加载与阈值项", html, ["自动加载上限", "文件树折叠阈值", "自动重生成防抖", "预览截断字符数"]);
  mustContainRaw("设置：默认值出现在输入框里", html, [
    'value="2400"',
    'value="250"',
    'value="700"',
  ]);
}

// ---- 11. 批量条：没有多选时不该占位 ----
{
  const empty = render("批量条（无多选）能渲染", <BulkBar count={0} needConfirm onRemove={noop} onEnable={noop} onDisable={noop} onInvert={noop} onClear={noop} />);
  mustNotContainRaw("批量条：count 为 0 时整条不渲染", empty, ["bulk-bar"]);
  const full = render("批量条（有多选）能渲染", <BulkBar count={4} needConfirm onRemove={noop} onEnable={noop} onDisable={noop} onInvert={noop} onClear={noop} />);
  mustContain("批量条：四个批量动作", full, ["已多选", "启用", "停用", "反选", "移除已选 (4)", "取消多选"]);
}

// ---- 12. 拖拽手柄：无障碍属性齐备 ----
{
  const html = render(
    "拖拽手柄能渲染",
    <PanelResizer width={520} targetRef={{ current: null as HTMLElement | null }} onCommit={noop} />
  );
  mustContainRaw("手柄：separator 与当前宽度", html, [
    'role="separator"',
    'aria-valuenow="520"',
    'aria-orientation="vertical"',
    "resizer-grip",
  ]);
}

// ---- 13. 整个 App 的装配：只测子组件不够，接线错了没人发现 ----
// App 在 Node 里能渲染是因为 renderToStaticMarkup 不跑 effect，所以 @tauri-apps/api
// 的调用（拖拽事件、IPC）都不会真的发生。但 useState 初始化里读的那些存档会真的执行，
// persistence 的 clampPanelWidth 要读 window.innerWidth —— 先把最小全局补上。
{
  const g = globalThis as unknown as { window: unknown; document: unknown };
  g.window = {
    innerWidth: 1280,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
  g.document = { documentElement: { dataset: {} } };
  const App = (await import("../src/App.tsx")).default;
  const html = render("App 装配能渲染", <App />);
  mustContain("App：顶栏与空态", html, ["Tauri 关键源码提取器", "还没有项目", "添加项目"]);
  mustContainRaw("App：侧边栏宽度写成 CSS 变量", html, ["--left-w:470px"]);
  mustContain("App：右侧默认选项", html, ["格式", "目录树", "统计信息", "单文件上限", "生成提取包"]);
  // 未启用/多选这些新交互在空列表下不该冒出来
  mustNotContainRaw("App：空列表不渲染批量条与设置浮层", html, ["bulk-bar", "settings-card"]);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
