"""Draws frames.json (pixelbar's cells per frame) as PNGs, terminal style.

Block characters are drawn as exact rectangles so the pixel art stays crisp;
everything else is text in DejaVu Sans Mono (DejaVu Sans as a fallback).
"""
import base64
import json
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H = 10, 20
PAD_X, PAD_Y = 18, 14
FONT_SIZE = 15
BG = (24, 24, 37)
FG = (205, 214, 244)
DEFAULT = 0x01000000

MONO = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', FONT_SIZE)
SANS = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', FONT_SIZE)
MISSING = MONO.getmask('').getbbox()


def font_for(ch):
    return SANS if MONO.getmask(ch).getbbox() == MISSING else MONO


def rgb(c, default):
    if c & DEFAULT:
        return default
    return ((c >> 16) & 255, (c >> 8) & 255, c & 255)


# Block elements as fractions of the cell: (x0, y0, x1, y1).
BLOCKS = {'█': (0, 0, 1, 1), '▀': (0, 0, 1, 0.5), '▄': (0, 0.5, 1, 1)}
for i, ch in enumerate('▁▂▃▄▅▆▇', start=1):
    BLOCKS[ch] = (0, 1 - i / 8, 1, 1)
for i, ch in enumerate('▏▎▍▌▋▊▉', start=1):
    BLOCKS[ch] = (0, 0, i / 8, 1)
LINES = {'━': 0.16, '─': 0.08}
CAPS = {'\ue0b6': 'left', '\ue0b4': 'right'}


def draw_frame(frame):
    cols, rows = frame['cols'], frame['rows']
    raw = base64.b64decode(frame['cells'])
    words = struct.unpack(f'<{len(raw) // 4}I', raw)
    extra = len(frame['button']) + 6 if frame.get('button') else 0
    img = Image.new('RGB', (PAD_X * 2 + (cols + extra) * CELL_W, PAD_Y * 2 + rows * CELL_H), BG)
    d = ImageDraw.Draw(img)
    for i in range(cols * rows):
        cp, fg, bg = words[i * 3: i * 3 + 3]
        x = PAD_X + (i % cols) * CELL_W
        y = PAD_Y + (i // cols) * CELL_H
        fgc, bgc = rgb(fg, FG), rgb(bg, BG)
        if bgc != BG:
            d.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], fill=bgc)
        ch = chr(cp)
        if ch == ' ':
            continue
        if ch in BLOCKS:
            x0, y0, x1, y1 = BLOCKS[ch]
            d.rectangle([x + round(x0 * CELL_W), y + round(y0 * CELL_H),
                         x + round(x1 * CELL_W) - 1, y + round(y1 * CELL_H) - 1], fill=fgc)
        elif ch in CAPS:
            # The Powerline half circles, as a terminal that draws them has them.
            if CAPS[ch] == 'left':
                d.pieslice([x, y, x + 2 * CELL_W - 1, y + CELL_H - 1], 90, 270, fill=fgc)
            else:
                d.pieslice([x - CELL_W, y, x + CELL_W - 1, y + CELL_H - 1], 270, 90, fill=fgc)
        elif ch in LINES:
            t = max(2, round(LINES[ch] * CELL_H))
            mid = y + CELL_H // 2
            d.rectangle([x, mid - t // 2, x + CELL_W - 1, mid - t // 2 + t - 1], fill=fgc)
        else:
            d.text((x + CELL_W / 2, y + CELL_H / 2), ch, font=font_for(ch), fill=fgc, anchor='mm')
    if frame.get('button'):
        x = PAD_X + (cols + 1) * CELL_W
        label = f"[ {frame['button']} ]"
        for j, ch in enumerate(label):
            d.text((x + j * CELL_W + CELL_W / 2, PAD_Y + CELL_H / 2), ch, font=MONO, fill=FG, anchor='mm')
    return img


def main():
    frames = json.loads(Path('frames.json').read_text())
    out = Path('png')
    out.mkdir(exist_ok=True)
    # Pad every frame to the widest so the GIF keeps one size.
    imgs = [draw_frame(f) for f in frames]
    w = max(i.width for i in imgs)
    for n, img in enumerate(imgs):
        canvas = Image.new('RGB', (w, img.height), BG)
        canvas.paste(img, (0, 0))
        canvas.save(out / f'{n:04d}.png')
    print(f'{len(imgs)} frames, {w}x{imgs[0].height}')


if __name__ == '__main__':
    sys.exit(main())
