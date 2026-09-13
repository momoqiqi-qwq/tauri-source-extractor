const SHORTCUTS: [string, string][] = [
  ["Ctrl + Enter", "生成提取包"],
  ["Ctrl + S", "保存文件"],
  ["Ctrl + Shift + C", "复制提取包"],
  ["Ctrl + F 或 /", "聚焦搜索框（会自动切到提取视图）"],
  ["Ctrl + 1 / Ctrl + 2", "切换 提取 / 已加载文件夹"],
  ["?", "显示本速查表"],
  ["Esc", "关闭弹层"],
];

/** 快捷键速查浮层：? 呼出，点遮罩 / × / Esc 关闭 */
export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-label="键盘快捷键"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <b>键盘快捷键</b>
          <button className="banner-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>
        <table className="shortcut-table">
          <tbody>
            {SHORTCUTS.map(([keys, desc]) => (
              <tr key={keys}>
                <td>
                  <kbd>{keys}</kbd>
                </td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
