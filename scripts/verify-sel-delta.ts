/**
 * 校验「勾选增量」的存/取往返是否无损。
 *
 * 直接 import `src/selection.ts`，**不复制逻辑** —— 否则脚本会和实现悄悄漂移，
 * 给出虚假的通过。前端没有测试框架，而这段逻辑一旦出错会静默破坏用户的勾选
 * （不报错、只是少勾/多勾），所以单独兜一层。
 *
 * 运行：npm run verify:sel
 */

import {
  applyDelta,
  bulkSelect,
  computeDelta,
  defaultSelection,
  invertMark,
  markAll,
  mergeRescan,
  nextSelMap,
  parseSelMap,
  rangeMark,
  toggleCategory,
  type ArchiveEntry,
} from "../src/selection.ts";

const files = [
  { relPath: "src/App.tsx", isKey: true },
  { relPath: "src/main.tsx", isKey: true },
  { relPath: "src-tauri/src/lib.rs", isKey: true },
  { relPath: "src-tauri/tauri.conf.json", isKey: true },
  { relPath: "config.json", isKey: true },
  { relPath: "README.md", isKey: true },
  { relPath: "docs/guide.md", isKey: false },
  { relPath: "LICENSE", isKey: false },
  { relPath: "src-tauri/icons/icon.png", isKey: false },
];

const KEY_PATHS = files.filter((f) => f.isKey).map((f) => f.relPath);
const ALL_PATHS = files.map((f) => f.relPath);

const eq = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
const show = (s: Set<string>) => [...s].sort().join(", ") || "(空)";

let failures = 0;
function check(label: string, got: Set<string>, want: Set<string>) {
  const ok = eq(got, want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        期望: ${show(want)}`);
    console.log(`        实际: ${show(got)}`);
  }
}

/** 非集合类断言（布尔、同一性） */
function checkTrue(label: string, ok: boolean) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

// 1) 默认勾选 = 所有关键文件
check("默认勾选 = 所有关键文件", defaultSelection(files), new Set(KEY_PATHS));

// 2) 未改动 → 增量为空
{
  const d = computeDelta(files, defaultSelection(files));
  check("未改动时增量为空", new Set([...d.off, ...d.on]), new Set());
}

// 3) 取消默认项 + 选上非默认项 → 增量精确，且往返无损
{
  const selected = defaultSelection(files);
  selected.delete("src/App.tsx");
  selected.delete("config.json");
  selected.add("docs/guide.md");
  selected.add("LICENSE");

  const d = computeDelta(files, selected);
  check("off 只含被取消的默认项", new Set(d.off), new Set(["src/App.tsx", "config.json"]));
  check("on 只含被选上的非默认项", new Set(d.on), new Set(["docs/guide.md", "LICENSE"]));
  check("往返后勾选完全一致", applyDelta(files, d), selected);
}

// 4) 全不选 / 全选 两个极端
{
  const none = new Set<string>();
  const dNone = computeDelta(files, none);
  check("全不选：off 覆盖全部关键文件", new Set(dNone.off), new Set(KEY_PATHS));
  check("全不选：往返后仍为空", applyDelta(files, dNone), none);

  const all = new Set(ALL_PATHS);
  check("全选：往返后仍是全选", applyDelta(files, computeDelta(files, all)), all);
}

// 5) 文件消失：off 里指向已删除的文件，不应报错也不应凭空出现
{
  const shrunk = files.filter((f) => f.relPath !== "src/App.tsx");
  check(
    "文件消失：已删除的 off 项被忽略，其余照常",
    applyDelta(shrunk, { off: ["src/App.tsx", "config.json"], on: ["LICENSE"] }),
    new Set(["src/main.tsx", "src-tauri/src/lib.rs", "src-tauri/tauri.conf.json", "README.md", "LICENSE"])
  );
}

// 6) 存档里的 on 指向不存在的文件 → 忽略它
{
  check(
    "存档 on 指向已删除文件：忽略",
    applyDelta(files, { off: [], on: ["deleted/old-file.ts"] }),
    new Set(KEY_PATHS)
  );
}

// 7) 重扫：保留旧勾选 + 补上新出现的关键文件
{
  const oldFiles = files.filter((f) => f.relPath !== "src/new.tsx");
  const newFiles = [...oldFiles, { relPath: "src/new.tsx", isKey: true }];
  const selected = defaultSelection(oldFiles);
  selected.delete("config.json"); // 用户手动取消了一个

  const merged = mergeRescan(oldFiles, newFiles, selected);
  check(
    "重扫：保留用户取消的项，同时补上新关键文件",
    merged,
    new Set([...KEY_PATHS, "src/new.tsx"].filter((x) => x !== "config.json"))
  );
}

// 8) 重扫：被删除的文件要从勾选里剔除
{
  const shrunk = files.filter((f) => f.relPath !== "src/App.tsx");
  const merged = mergeRescan(files, shrunk, defaultSelection(files));
  check(
    "重扫：已删除的文件不再被勾选",
    merged,
    new Set(KEY_PATHS.filter((x) => x !== "src/App.tsx"))
  );
}

// 9) 存档解析：坏 JSON / 结构异常都不能抛错
{
  check("存档损坏 → 空表", new Set(Object.keys(parseSelMap("{不是 JSON"))), new Set());
  check("存档为 null → 空表", new Set(Object.keys(parseSelMap(null))), new Set());
  const good = parseSelMap('{"d:\\\\a":{"off":["x.ts"],"on":[123,"y.md"]}}');
  check(
    "存档解析：非字符串项被过滤",
    new Set(good["d:\\a"].off.concat(good["d:\\a"].on)),
    new Set(["x.ts", "y.md"])
  );
}

// 10) 批量操作：四种模式的语义
{
  const base = defaultSelection(files);
  check("批量 all → 全部文件", bulkSelect(files, "all", base), new Set(ALL_PATHS));
  check("批量 none → 空", bulkSelect(files, "none", base), new Set());
  check("批量 key → 仅关键文件", bulkSelect(files, "key", new Set()), new Set(KEY_PATHS));

  // invert 是相对当前的操作：默认勾选取反 = 非关键文件
  const inverted = bulkSelect(files, "invert", base);
  check(
    "批量 invert → 相对当前取反",
    inverted,
    new Set(ALL_PATHS.filter((x) => !base.has(x)))
  );
  check("批量 invert 两次 → 回到原状", bulkSelect(files, "invert", inverted), base);

  // 空集合取反 = 全选（边界）
  check("批量 invert 于空集 → 全选", bulkSelect(files, "invert", new Set()), new Set(ALL_PATHS));
}

// 11) 分类 chip：三态语义
{
  const cats = [
    { relPath: "src/App.tsx", isKey: true, category: "frontend" as const },
    { relPath: "src/main.tsx", isKey: true, category: "frontend" as const },
    { relPath: "src-tauri/src/lib.rs", isKey: true, category: "rust" as const },
    { relPath: "src-tauri/tauri.conf.json", isKey: true, category: "tauri-config" as const },
    { relPath: "docs/guide.md", isKey: false, category: "docs" as const },
  ];
  const frontend = new Set(["src/App.tsx", "src/main.tsx"]);
  const allPaths = new Set(cats.map((f) => f.relPath));

  check(
    "分类：全未选 → 该分类全选",
    toggleCategory(cats, "frontend", new Set()),
    frontend
  );
  check(
    "分类：全已选 → 该分类全取消",
    toggleCategory(cats, "frontend", allPaths),
    new Set(["src-tauri/src/lib.rs", "src-tauri/tauri.conf.json", "docs/guide.md"])
  );
  // 关键：部分选中时应当是「补齐为全选」，而不是把已选的取消掉
  check(
    "分类：部分选中 → 补齐为全选（不是取反）",
    toggleCategory(cats, "frontend", new Set(["src/App.tsx"])),
    frontend
  );
  // 只影响该分类，其他分类必须原样不动
  check(
    "分类：不影响其他分类",
    toggleCategory(cats, "rust", new Set(["docs/guide.md"])),
    new Set(["docs/guide.md", "src-tauri/src/lib.rs"])
  );

  // 空分类 → 必须返回**同一个引用**，调用方据此跳过重渲染
  const before = new Set(["src/App.tsx"]);
  const after = toggleCategory(cats, "env", before);
  checkTrue("分类：空分类返回同一引用（no-op 可被识别）", after === before);
}

// 12) 持久化存档合并：nextSelMap（persistence.ts 纯函数，App 写盘前最后一步）
{
  const KEY = "e:\\a";
  // ArchiveEntry.scan 的完整类型是 ScanResult，这里只用到 files 字段
  const scan = { files } as unknown as ArchiveEntry["scan"];
  const withSel = (fn: (s: Set<string>) => void): ArchiveEntry => {
    const selected = defaultSelection(files);
    fn(selected);
    return { root: KEY, scan, selected };
  };
  const defaulted = withSel(() => {});
  const offOne = withSel((s) => s.delete("config.json"));
  const onOne = withSel((s) => s.add("docs/guide.md"));

  // 默认勾选 → 不产生存档（存增量不存全量）
  const emptyNext = nextSelMap({}, [defaulted]);
  checkTrue("存档：默认勾选的项目不产生存档", !(KEY in emptyNext));

  // 有改动 → 记录增量；改回默认 → 存档清除
  const withOff = nextSelMap({}, [offOne]);
  checkTrue(
    "存档：取消勾选被记录为 off 增量",
    KEY in withOff && withOff[KEY].off.length === 1 && withOff[KEY].off[0] === "config.json"
  );
  checkTrue("存档：改回默认后存档被清除", !(KEY in nextSelMap(withOff, [defaulted])));

  const withOn = nextSelMap({}, [onOne]);
  checkTrue(
    "存档：额外勾选被记录为 on 增量",
    KEY in withOn && withOn[KEY].on.length === 1 && withOn[KEY].on[0] === "docs/guide.md"
  );

  // 扫描失败（scan 为 null）→ 保留旧存档，绝不能被空勾选覆盖
  const failed: ArchiveEntry = { root: KEY, scan: null, selected: new Set() };
  checkTrue("存档：扫描失败的项目保留旧存档", KEY in nextSelMap(withOff, [failed]));

  // 项目被移除 → 存档一并清掉
  checkTrue("存档：已移除项目的存档被清掉", !(KEY in nextSelMap(withOff, [])));

  // 「未启用 = 还没扫描」的项目必须留在 entries 里传给 nextSelMap。
  // 若调用方图省事只传已启用的项目，alive 集合就少了它，上次存的勾选会被悄悄删掉。
  const OFF_KEY = "e:\\disabled";
  const kept = nextSelMap({ [OFF_KEY]: { off: ["config.json"], on: [] } }, [
    { root: OFF_KEY, scan: null, selected: new Set() },
    offOne,
  ]);
  checkTrue("存档：未启用（未扫描）的项目，其存档不被相邻项目的写入冲掉", OFF_KEY in kept);
}

// 13) 多选标记：全选三态 / 取反 / Shift 区间
{
  const ids = ["a", "b", "c", "d"];
  check("多选：空集点全选 → 全部", markAll(ids, new Set()), new Set(ids));
  check("多选：已全选再点全选 → 清空（三态）", markAll(ids, new Set(ids)), new Set());
  check(
    "多选：部分已选再点全选 → 补齐为全部",
    markAll(ids, new Set(["a"])),
    new Set(ids)
  );
  const untouched = new Set<string>();
  checkTrue(
    "多选：空列表点全选 → 返回同一引用（no-op 可被识别）",
    markAll([], untouched) === untouched
  );
  // 筛选后表头只剩 a、b：全选态取消时不能把屏幕外的 c、d 一起清掉
  check(
    "多选：全选取消只影响当前可见批次",
    markAll(["a", "b"], new Set(["a", "b", "c", "d"])),
    new Set(["c", "d"])
  );

  check(
    "多选：取反只在可见集合内生效",
    invertMark(["a", "b"], new Set(["b", "z"])),
    new Set(["a", "z"])
  );
  check("多选：取反两次回到原状", invertMark(ids, invertMark(ids, new Set(["a"]))), new Set(["a"]));

  // Shift 点选：倒序拖（从后往前点）也要覆盖中间
  check(
    "多选：Shift 区间 正向",
    rangeMark(ids, "a", "c", new Set()),
    new Set(["a", "b", "c"])
  );
  check(
    "多选：Shift 区间 反向（从 d 拖到 b）",
    rangeMark(ids, "d", "b", new Set()),
    new Set(["b", "c", "d"])
  );
  check(
    "多选：Shift 区间 保留已有标记",
    rangeMark(ids, "a", "b", new Set(["d"])),
    new Set(["a", "b", "d"])
  );
  check(
    "多选：Shift 区间 单点（锚点=目标）",
    rangeMark(ids, "c", "c", new Set()),
    new Set(["c"])
  );
  // 筛选后锚点已被过滤掉 → 不该乱标，原样返回
  const before = new Set(["a"]);
  checkTrue("多选：Shift 区间 锚点不在列表中 → 不动", rangeMark(["b", "c"], "a", "c", before) === before);
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
