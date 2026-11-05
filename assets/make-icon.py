# -*- coding: utf-8 -*-
"""生成插件市场的商店卡片图标（180×180 与 512×512 PNG）。

设计：深墨绿圆角底 + 账本封面 + 一枚金币（记账）与一条上扬折线（理财）。
不写文字，避免任何语言/字体依赖；缩到 40px 仍能看出「账本 + 钱」。
"""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent
INK = (17, 46, 43, 255)        # 背景：墨绿
PAPER = (247, 243, 233, 255)   # 账本纸色
GOLD = (226, 168, 74, 255)     # 金币
JADE = (86, 190, 156, 255)     # 折线
SPINE = (32, 78, 71, 255)      # 书脊


def draw(size: int) -> Image.Image:
    s = 4  # 超采样，边缘更干净
    W = size * s
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底
    r = int(W * 0.22)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=r, fill=INK)

    # 账本：略偏左，竖向长方形
    bx0, by0 = W * 0.20, W * 0.18
    bx1, by1 = W * 0.66, W * 0.82
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(W * 0.05), fill=PAPER)
    # 书脊
    d.rounded_rectangle([bx0, by0, bx0 + W * 0.075, by1], radius=int(W * 0.035), fill=SPINE)
    # 账本上的三条记账线
    line_x0 = bx0 + W * 0.15
    for i, y in enumerate((0.34, 0.44, 0.54)):
        width = W * (0.20 if i < 2 else 0.12)
        d.rounded_rectangle(
            [line_x0, W * y, line_x0 + width, W * y + W * 0.032],
            radius=int(W * 0.016), fill=(205, 198, 182, 255),
        )

    # 金币：右下，压在账本角上
    cx, cy, cr = W * 0.720, W * 0.755, W * 0.145
    d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=GOLD)
    d.ellipse(
        [cx - cr * 0.62, cy - cr * 0.62, cx + cr * 0.62, cy + cr * 0.62],
        outline=(255, 235, 190, 255), width=int(W * 0.018),
    )

    # 右上：三根递增柱子（理财），与金币保持间隙，不互相压线
    base_y = W * 0.505
    for x, height in ((0.700, 0.080), (0.756, 0.115), (0.812, 0.152)):
        d.rounded_rectangle(
            [W * x, base_y - W * height, W * (x + 0.042), base_y],
            radius=int(W * 0.016), fill=JADE,
        )

    return img.resize((size, size), Image.LANCZOS)


for target in (180, 512):
    out = OUT / f'icon-{target}.png'
    draw(target).save(out, 'PNG', optimize=True)
    print(f'wrote {out}')

# 顺手出一张 1024 宽的大图给 README 用
draw(512).save(OUT / 'icon.png', 'PNG', optimize=True)
print('wrote', OUT / 'icon.png')
