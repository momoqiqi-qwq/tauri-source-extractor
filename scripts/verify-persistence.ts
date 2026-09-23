/**
 * 校验 localStorage 存档的读/写往返。
 *
 * 为什么单独一层：存档出错是**静默**的 —— 不报错，只是悄悄丢设置、悄悄把
 * 面板宽度写成 NaN、悄悄把上次的「哪些文件夹已启用」清空。而这几处都要到
 * 下次启动才看得见，那时已经分不清是代码坏了还是本来就这样。
 *
 * 直接 import `src/persistence.ts`，不复制逻辑（复制一份必然与实现漂移）。
 *
 * 运行：npm run verify:persist
 */

const store = new Map<string, string>();

/** 隐私模式 / 配额满时 localStorage 会抛错，用来验证不会连带把应用打不开 */
let throwing = false;
const storageStub = {
  getItem: (k: string) => {
    if (throwing) throw new Error("SecurityError: storage is disabled");
    return store.has(k) ? (store.get(k) as string) : null;
  },
  setItem: (k: string, v: string) => {
    if (throwing) throw new Error("QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size;
  },
};

// persistence.ts 顶层不碰 DOM，但 clampPanelWidth 默认读 window.innerWidth；
// 必须先挂好全局，再动态 import，否则模块求值时就炸。
(globalThis as unknown as { localStorage: unknown }).localStorage = storageStub;
(globalThis as unknown as { window: unknown }).window = { innerWidth: 1200 };

const { DEFAULT_SETTINGS } = await import("../src/types.ts");
const {
  DEFAULT_OPTIONS,
  OPTIONS_KEY,
  ROOTS_KEY,
  SETTINGS_KEY,
  loadOptions,
  loadRoots,
  loadSettings,
  saveRoots,
  saveSettings,
} = await import("../src/persistence.ts");

let failures = 0;
function ok(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass || !detail ? "" : `\n        ${detail}`}`);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// 1) 无存档 → 全默认
ok("无存档 → 默认设置", eq(loadSettings(), DEFAULT_SETTINGS));
ok("无存档 → 空项目列表", loadRoots().length === 0);

// 2) 写入后原样读回（含 enabled=false 的那条）
saveSettings({ ...DEFAULT_SETTINGS, toastTtl: 8000, autoLoadLimit: 0, confirmBulkRemove: false });
{
  const back = loadSettings();
  ok(
    "设置往返无损",
    back.toastTtl === 8000 && back.autoLoadLimit === 0 && back.confirmBulkRemove === false,
    JSON.stringify(back)
  );
}

saveRoots([
  { root: "E:\\a", enabled: true },
  { root: "E:\\b", enabled: false },
]);
{
  const back = loadRoots();
  ok(
    "项目列表往返：启用状态逐条保留",
    eq(back, [
      { root: "E:\\a", enabled: true },
      { root: "E:\\b", enabled: false },
    ]),
    JSON.stringify(back)
  );
}

// 3) 坏数据：一个都不能把 NaN / undefined 漏进界面
{
  store.set(
    SETTINGS_KEY,
    '{"toastTtl":"abc","autoLoadLimit":null,"previewLimit":{},"errorTtl":"","regenDebounce":false,"treeCollapseAt":[]}'
  );
  const s = loadSettings();
  ok(
    "坏存档：非数值字段回落默认，不产生 NaN 也不被悄悄当成 0",
    s.toastTtl === DEFAULT_SETTINGS.toastTtl &&
      s.autoLoadLimit === DEFAULT_SETTINGS.autoLoadLimit &&
      s.previewLimit === DEFAULT_SETTINGS.previewLimit &&
      s.errorTtl === DEFAULT_SETTINGS.errorTtl &&
      s.regenDebounce === DEFAULT_SETTINGS.regenDebounce &&
      s.treeCollapseAt === DEFAULT_SETTINGS.treeCollapseAt,
    JSON.stringify(s)
  );
}
{
  store.set(SETTINGS_KEY, "不是 JSON");
  ok("坏存档：JSON 解析失败 → 全默认", eq(loadSettings(), DEFAULT_SETTINGS));
}
{
  // 存档只写了一半（新版本加了字段，旧存档里没有）
  store.set(SETTINGS_KEY, '{"toastTtl":3000}');
  const s = loadSettings();
  ok(
    "缺字段的存档 → 逐字段补默认",
    s.toastTtl === 3000 && s.regenDebounce === DEFAULT_SETTINGS.regenDebounce,
    JSON.stringify(s)
  );
}

// 4) 面板宽度越界要钳住：320 下限，上限受窗口宽度约束（innerWidth 1200 - 360 = 840）
{
  store.set(SETTINGS_KEY, '{"leftPanelWidth":10}');
  ok("宽度过小 → 钳到下限 320", loadSettings().leftPanelWidth === 320, String(loadSettings().leftPanelWidth));
  store.set(SETTINGS_KEY, '{"leftPanelWidth":99999}');
  ok("宽度过大 → 钳到窗口上限 840", loadSettings().leftPanelWidth === 840, String(loadSettings().leftPanelWidth));
  store.set(SETTINGS_KEY, '{"leftPanelWidth":"400"}');
  ok("字符串数字 → 接受并转成 number", loadSettings().leftPanelWidth === 400);
}

// 5) 老版本存档迁移：v2 只有路径数组，没有启用概念
{
  store.clear();
  store.set("tse.roots.v2", JSON.stringify(["E:\\x", "E:\\y"]));
  const back = loadRoots();
  ok(
    "v2 存档迁移：路径保留，一律未启用（新模型下没人勾过就不该自动读盘）",
    eq(back, [
      { root: "E:\\x", enabled: false },
      { root: "E:\\y", enabled: false },
    ]),
    JSON.stringify(back)
  );
}
{
  store.clear();
  store.set(ROOTS_KEY, '["E:\\\\mixed", {"root":"E:\\\\obj","enabled":true}]');
  const back = loadRoots();
  ok(
    "v3 存档里混入纯字符串 → 当作未启用，不崩",
    eq(back, [
      { root: "E:\\mixed", enabled: false },
      { root: "E:\\obj", enabled: true },
    ]),
    JSON.stringify(back)
  );
}
{
  store.clear();
  store.set(ROOTS_KEY, "{坏的}");
  ok("坏的项目存档 → 空列表而不是抛错", loadRoots().length === 0);
}

// 6) 导出选项：默认值、往返、缺字段补齐
{
  store.clear();
  ok("无存档 → 默认导出格式 markdown", loadOptions().format === "markdown");
  store.set(
    OPTIONS_KEY,
    JSON.stringify({ format: "xml", includeTree: false, includeMeta: true, header: "hi", maxFileKb: 100 })
  );
  const back = loadOptions();
  ok(
    "导出选项往返",
    back.format === "xml" && back.includeTree === false && back.maxFileKb === 100,
    JSON.stringify(back)
  );
  store.set(OPTIONS_KEY, '{"format":"plain"}');
  const partial = loadOptions();
  ok(
    "导出选项缺字段 → 补默认（新版本加字段时老存档不能崩）",
    partial.format === "plain" && partial.maxFileKb === DEFAULT_OPTIONS.maxFileKb,
    JSON.stringify(partial)
  );
}

// 7) localStorage 整个不可用（隐私模式）→ 应用仍要能起
{
  throwing = true;
  let crashed = false;
  try {
    loadSettings();
    loadRoots();
    saveSettings(DEFAULT_SETTINGS);
    saveRoots([{ root: "E:\\z", enabled: true }]);
  } catch {
    crashed = true;
  }
  ok("localStorage 抛错 → 读写全部静默降级，不崩", !crashed);
  ok("localStorage 抛错 → 仍返回默认设置", eq(loadSettings(), DEFAULT_SETTINGS));
  throwing = false;
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
