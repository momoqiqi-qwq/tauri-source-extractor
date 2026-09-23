import { useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { clampPanelWidth, DEFAULT_SETTINGS, PANEL_MIN_WIDTH } from "../types";

interface Props {
  /** 已提交的宽度（React 侧的真相） */
  width: number;
  /** 承载 --left-w 的元素，通常是 .app */
  targetRef: RefObject<HTMLElement | null>;
  onCommit: (w: number) => void;
}

/** 键盘步长：方向点 16px，按住 Shift 64px */
const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

/**
 * 左侧面板的拖拽手柄。
 *
 * 拖拽过程中宽度**不走 React state**：直接把手上的值写进 --left-w，
 * 松手时才 onCommit 一次。两个原因：
 * 1) 每移动一像素就重渲染整棵项目树，拖动本身就会卡；
 * 2) 宽度是要落 localStorage 的，逐帧写盘等于把磁盘当内存用。
 */
export default function PanelResizer({ width, targetRef, onCommit }: Props) {
  const startRef = useRef<{ x: number; w: number } | null>(null);

  const setLive = (w: number) => {
    targetRef.current?.style.setProperty("--left-w", `${w}px`);
  };

  // 拖到一半切视图 / 卸载 → 别让 body 上的 is-resizing 卡住光标和文字选中
  useEffect(
    () => () => {
      document.body.classList.remove("is-resizing");
    },
    []
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startRef.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("active");
    document.body.classList.add("is-resizing");
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    setLive(clampPanelWidth(start.w + (e.clientX - start.x)));
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    startRef.current = null;
    e.currentTarget.classList.remove("active");
    document.body.classList.remove("is-resizing");
    const shown = targetRef.current
      ? parseFloat(getComputedStyle(targetRef.current).getPropertyValue("--left-w"))
      : NaN;
    onCommit(clampPanelWidth(Number.isFinite(shown) ? shown : width));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = width - big;
    else if (e.key === "ArrowRight") next = width + big;
    else if (e.key === "Home") next = DEFAULT_SETTINGS.leftPanelWidth;
    if (next === null) return;
    e.preventDefault();
    const clamped = clampPanelWidth(next);
    setLive(clamped);
    onCommit(clamped);
  };

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整左侧面板宽度"
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      tabIndex={0}
      title="拖动调整宽度 · 双击复位 · 点住后用 ←/→"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        setLive(DEFAULT_SETTINGS.leftPanelWidth);
        onCommit(DEFAULT_SETTINGS.leftPanelWidth);
      }}
      onKeyDown={onKeyDown}
    >
      <span className="resizer-grip" aria-hidden />
    </div>
  );
}
