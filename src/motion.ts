/**
 * 动效系统的 JS 侧：弹层（toast / 错误横幅）统一的「进 → 停 → 出」生命周期。
 *
 * 分层约定（与 styles.css 末尾的「动效系统」区块互为镜像）：
 * 1) token —— 时长与缓动只定义在 styles.css 的 --dur-* / --ease-*；
 * 2) 生命周期 —— 本文件的 usePresence，负责弹层什么时候挂载、什么时候退场；
 * 3) 进场模式 —— CSS keyframes 绑定在组件类名上，谁挂载谁播放。
 *
 * JS 只需要知道两个数值，改 CSS 时必须同步这里：
 *   MOTION.exit    退场动画时长（--dur-exit），到点后真正卸载元素
 *   MOTION.toastTtl toast 停留时长
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const MOTION = {
  fast: 120,
  base: 200,
  slow: 300,
  /** 对齐 styles.css 的 --dur-exit */
  exit: 160,
  toastTtl: 2400,
} as const;

export interface PresenceState<T> {
  value: T;
  /** true = 正在播退场动画，播完（MOTION.exit）才真正卸载 */
  leaving: boolean;
}

/**
 * 弹层生命周期钩子。
 *
 * - show(value)：进场；带 ttl 时到点自动退场
 * - dismiss()：先置 leaving 播退场动画，再卸载——弹层不再是「啪一下消失」
 * - set(value | null)：兼容旧的 setError(msg | null) 写法，null 即退场
 *
 * 靠递增的 seq 给元素当 key：退场途中再次 show() 会打断退场、重挂载、
 * 进场动画完整重播。这也顺带修掉了旧 setTimeout 实现「连续 flash 时，
 * 第一条的定时器把第二条提前清掉」的问题——每次 show 都重置计时器。
 */
export function usePresence<T>(ttl: number | null = null) {
  const [current, setCurrent] = useState<PresenceState<T> | null>(null);
  const [seq, setSeq] = useState(0);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    // 没有内容或已在退场 → 不重复启动
    setCurrent((c) => (c && !c.leaving ? { ...c, leaving: true } : c));
    timers.current.push(window.setTimeout(() => setCurrent(null), MOTION.exit));
  }, [clearTimers]);

  const show = useCallback(
    (value: T) => {
      clearTimers();
      setSeq((s) => s + 1);
      setCurrent({ value, leaving: false });
      if (ttl !== null) {
        timers.current.push(window.setTimeout(dismiss, ttl));
      }
    },
    [ttl, dismiss, clearTimers]
  );

  const set = useCallback(
    (value: T | null) => {
      if (value === null) dismiss();
      else show(value);
    },
    [dismiss, show]
  );

  // 卸载时清掉所有未决定时器，避免 setState 打到已卸载的组件上
  useEffect(() => clearTimers, [clearTimers]);

  return { current, seq, show, set, dismiss };
}
