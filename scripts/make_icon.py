"""生成 1024x1024 的源图标 PNG（纯标准库，无第三方依赖）。

图形：蓝紫渐变圆角方块 + 白色 `</>` 代码符号。
产物供 `npx tauri icon` 生成各平台图标集。
"""

import math
import struct
import zlib
from pathlib import Path

W = H = 1024
MARGIN = 16
RADIUS = 200

C1 = (37, 99, 235)    # #2563eb
C2 = (124, 58, 237)   # #7c3aed
WHITE = (255, 255, 255)

STROKE = 32.0  # 半宽

# 线段定义：(x1, y1, x2, y2)
SEGMENTS = [
    # <
    (376, 356, 288, 512),
    (288, 512, 376, 668),
    # >
    (648, 356, 736, 512),
    (736, 512, 648, 668),
    # /
    (566, 372, 466, 664),
]


def sd_round_rect(x: float, y: float, w: float, h: float, r: float) -> float:
    dx = abs(x) - (w / 2 - r)
    dy = abs(y) - (h / 2 - r)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def dist_to_segment(px: float, py: float, x1, y1, x2, y2) -> float:
    vx, vy = x2 - x1, y2 - y1
    wx, wy = px - x1, py - y1
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    cx, cy = x1 + t * vx, y1 + t * vy
    return math.hypot(px - cx, py - cy)


def coverage(d: float) -> float:
    """把有符号距离转成 0..1 覆盖率，做 1.5px 抗锯齿。"""
    return max(0.0, min(1.0, 0.5 - d / 1.5))


def lerp(a, b, t):
    return a + (b - a) * t


def main() -> None:
    rows = []
    half = W / 2

    for y in range(H):
        row = bytearray()
        for x in range(W):
            fx, fy = x + 0.5, y + 0.5

            # 背景圆角矩形
            d = sd_round_rect(fx - half, fy - half, W - 2 * MARGIN, H - 2 * MARGIN, RADIUS)
            bg_a = coverage(d)
            if bg_a <= 0:
                row += b"\x00\x00\x00\x00"
                continue

            # 渐变
            t = (fx + fy) / (2.0 * W)
            r = lerp(C1[0], C2[0], t)
            g = lerp(C1[1], C2[1], t)
            b = lerp(C1[2], C2[2], t)

            # 白色描边符号
            ds = min(
                dist_to_segment(fx, fy, *seg) for seg in SEGMENTS
            )
            cov = coverage(ds - STROKE)
            if cov > 0:
                r = lerp(r, WHITE[0], cov)
                g = lerp(g, WHITE[1], cov)
                b = lerp(b, WHITE[2], cov)

            row += bytes((int(r), int(g), int(b), int(bg_a * 255)))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )

    out = Path(__file__).resolve().parent / "icon.png"
    out.write_bytes(png)
    print(f"written {out} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
