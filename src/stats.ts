/**
 * 选中统计 —— 顶栏总计、项目卡片、管理页表格共用的同一套口径。
 *
 * 曾经在三个组件里各写了一遍「遍历 files、累加选中行的行数与字节」，
 * 口径一旦调整就要同步三处，漂移了还不报错；现在收敛成一个纯函数，
 * token 估算与预算档位也在函数内一并算好，调用方拿到的必然一致。
 */
import type { BudgetLevel, ScanResult } from "./types";
import { budgetLevel, estimateTokensFromBytes } from "./types";

export interface ProjectStats {
  /** 扫描到的文件总数 */
  total: number;
  /** 当前勾选数（即 selected.size） */
  selected: number;
  selLines: number;
  selBytes: number;
  estTokens: number;
  tokenLevel: BudgetLevel;
}

export function projectStats(
  scan: ScanResult | null,
  selected: Set<string>
): ProjectStats {
  const files = scan?.files ?? [];
  let selLines = 0;
  let selBytes = 0;
  for (const f of files) {
    if (selected.has(f.relPath)) {
      selLines += f.lines;
      selBytes += f.size;
    }
  }
  const estTokens = estimateTokensFromBytes(selBytes);
  return {
    total: files.length,
    selected: selected.size,
    selLines,
    selBytes,
    estTokens,
    tokenLevel: budgetLevel(estTokens),
  };
}
