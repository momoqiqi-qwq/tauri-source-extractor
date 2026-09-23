import { useEffect, useState } from "react";

interface Props {
  /** 已多选的文件夹数，0 时整条不渲染 */
  count: number;
  /** 移除是否需要二次确认（设置项） */
  needConfirm: boolean;
  onRemove: () => void;
  onEnable: () => void;
  onDisable: () => void;
  onInvert: () => void;
  onClear: () => void;
}

/** armed 状态几秒后自己退回「未确认」，避免点过一次后按钮长期停在危险态 */
const ARM_TIMEOUT = 5000;

/**
 * 多选后的批量操作条。提取页与管理页共用这一份 —— 两处的「已选」是同一个集合，
 * 分成两套实现迟早出现一边能删一边不能删的漂移。
 */
export default function BulkBar({
  count,
  needConfirm,
  onRemove,
  onEnable,
  onDisable,
  onInvert,
  onClear,
}: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), ARM_TIMEOUT);
    return () => window.clearTimeout(t);
  }, [armed]);

  // 选中的文件夹变了就不该还停在「确认移除上一步的 N 个」上
  useEffect(() => setArmed(false), [count]);

  if (count === 0) return null;

  const remove = () => {
    // 注意判断顺序：needConfirm 关掉时必须直接放行，
    // 写成 `if (!needConfirm || !armed)` 会让「不确认」这条路径永远走不到 onRemove
    if (needConfirm && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onRemove();
  };

  return (
    <div className="bulk-bar">
      <span className="bulk-count">
        已多选 <b>{count}</b> 个文件夹
      </span>
      <button className="mini" onClick={onEnable} title="勾上启用：扫描并加载文件树">
        启用
      </button>
      <button className="mini" onClick={onDisable} title="取消启用：不扫描、不导出、不进统计">
        停用
      </button>
      <button className="mini" onClick={onInvert}>
        反选
      </button>
      <div className="spacer" />
      <button
        className={`mini danger${armed ? " armed" : ""}`}
        onClick={remove}
        title="只从列表移除，磁盘上的项目文件不会被动"
      >
        {armed ? `再点一次确认移除 ${count} 个` : `移除已选 (${count})`}
      </button>
      <button className="mini" onClick={onClear}>
        取消多选
      </button>
    </div>
  );
}
