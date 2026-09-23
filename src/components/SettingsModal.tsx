import { useEffect, useState } from "react";
import type { UiSettings } from "../types";
import { DEFAULT_SETTINGS } from "../types";

interface Props {
  settings: UiSettings;
  onChange: (patch: Partial<UiSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

interface NumRowProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onCommit: (n: number) => void;
}

/**
 * 数字设置行。
 *
 * 本地草稿 + 实时提交：直接受控于 settings 的话，清空输入框会被解析成 0
 * 立刻写回去，光标位置也跟着跳，没法把「2400」改成「3000」。
 */
function NumRow({ label, hint, value, min, max, step = 1, unit, onCommit }: NumRowProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const blur = () => {
    const n = Number(draft);
    const next = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="set-row">
      <span className="set-label">
        {label}
        {hint && <em className="set-hint">{hint}</em>}
      </span>
      <span className="set-input">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= min && n <= max) onCommit(Math.round(n));
          }}
          onBlur={blur}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        {unit && <span className="set-unit">{unit}</span>}
      </span>
    </label>
  );
}

function BoolRow({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onCommit: (b: boolean) => void;
}) {
  return (
    <label className="set-row check">
      <input type="checkbox" checked={value} onChange={(e) => onCommit(e.target.checked)} />
      <span className="set-label">
        {label}
        {hint && <em className="set-hint">{hint}</em>}
      </span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="set-group">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** 设置面板：把原先写死在代码里的时长、阈值、宽度集中到一处可改。 */
export default function SettingsModal({ settings, onChange, onReset, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card settings-card"
        role="dialog"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <b>设置</b>
          <span className="muted tiny">改动即时生效并自动保存</span>
          <button className="banner-close" onClick={onClose} title="关闭（Esc）">
            ×
          </button>
        </div>

        <div className="settings-body">
          <Group title="提醒">
            <NumRow
              label="提示停留时长"
              hint="提取、保存、打包完成后那条提示显示多久。0 = 不自动关闭"
              value={settings.toastTtl}
              min={0}
              max={60_000}
              step={100}
              unit="ms"
              onCommit={(n) => onChange({ toastTtl: n })}
            />
            <NumRow
              label="错误横幅停留时长"
              hint="0 = 一直显示到手动关闭"
              value={settings.errorTtl}
              min={0}
              max={60_000}
              step={100}
              unit="ms"
              onCommit={(n) => onChange({ errorTtl: n })}
            />
          </Group>

          <Group title="加载行为">
            <NumRow
              label="自动加载上限"
              hint="一次添加超过这个数量的文件夹时，默认全部不启用，等你勾选"
              value={settings.autoLoadLimit}
              min={0}
              max={500}
              onCommit={(n) => onChange({ autoLoadLimit: n })}
            />
            <BoolRow
              label="启用后自动展开文件树"
              hint="关闭则只加载数据，树保持收起"
              value={settings.expandOnEnable}
              onCommit={(b) => onChange({ expandOnEnable: b })}
            />
            <NumRow
              label="文件树折叠阈值"
              hint="单个文件夹超过这么多文件时，目录默认折叠。对之后展开的树生效，不会打断你当前手动展开的状态"
              value={settings.treeCollapseAt}
              min={20}
              max={5000}
              step={10}
              unit="个"
              onCommit={(n) => onChange({ treeCollapseAt: n })}
            />
          </Group>

          <Group title="导出与预览">
            <BoolRow
              label="勾选变化后自动重新生成预览"
              hint="关闭后只能手动点「生成提取包」"
              value={settings.autoRegenerate}
              onCommit={(b) => onChange({ autoRegenerate: b })}
            />
            <NumRow
              label="自动重生成防抖"
              hint="连续勾选时等多久再算，越大越省"
              value={settings.regenDebounce}
              min={0}
              max={5000}
              step={50}
              unit="ms"
              onCommit={(n) => onChange({ regenDebounce: n })}
            />
            <NumRow
              label="预览截断字符数"
              hint="超出部分不渲染，完整内容仍可复制/保存"
              value={settings.previewLimit}
              min={1_000}
              max={5_000_000}
              step={10_000}
              onCommit={(n) => onChange({ previewLimit: n })}
            />
          </Group>

          <Group title="界面">
            <NumRow
              label="左侧面板宽度"
              hint="也可以直接拖中间的分隔条，双击复位"
              value={settings.leftPanelWidth}
              min={320}
              max={1400}
              step={10}
              unit="px"
              onCommit={(n) => onChange({ leftPanelWidth: n })}
            />
            <BoolRow
              label="批量移除前二次确认"
              hint="只从列表移除，不会删除磁盘文件"
              value={settings.confirmBulkRemove}
              onCommit={(b) => onChange({ confirmBulkRemove: b })}
            />
          </Group>
        </div>

        <div className="settings-foot">
          <button className="mini" onClick={onReset}>
            恢复全部默认（{Object.keys(DEFAULT_SETTINGS).length} 项）
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
