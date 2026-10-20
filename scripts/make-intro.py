# Cuts the logo into layers for the home page's opening animation (python scripts/make-intro.py).
# The artwork stays exactly the logo in brand/: every layer is the same size as brand/logo-mark.png, so stacked
# with nothing moved they make the logo again. Re-run it whenever the logo changes, then look at the home page.
#   website/intro/book-l1..l3.png, book-r1..r3.png   the book's page stripes, top (the page they stand on) to bottom
#   website/intro/tutor.png, tutor-head.png            the tutor's body and arm, and head
#   website/intro/student.png, student-head.png        the student's body and arm, and the yellow head
#   website/intro/word.png                             "StudyBridge" from brand/logo-wordmark.png, cropped to the letters
import os
from collections import deque
import numpy as np
from PIL import Image

OUT = 'website/intro'
SOLID = 32  # pixels at least this opaque are the shapes themselves; fainter ones are their soft edges
# Where the student's hand ends and the tutor's begins (the two notches where the hands meet), as fractions of the
# logo's width and height. Check this first if a new logo cuts the hands in the wrong place.
HANDSHAKE = ((359 / 743, 157 / 458), (364 / 743, 168 / 458))

STEPS = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))


def components(mask):
    """Labels the connected shapes in a mask (8 neighbours); returns the label grid and how many there are."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    n = 0
    for y, x in zip(*np.nonzero(mask)):
        if lab[y, x]:
            continue
        n += 1
        lab[y, x] = n
        q = deque([(y, x)])
        while q:
            cy, cx = q.popleft()
            for dy, dx in STEPS:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = n
                    q.append((ny, nx))
    return lab, n


def grow(lab):
    """Gives every unlabelled pixel the label of the nearest labelled one, so soft edges go with their shape."""
    h, w = lab.shape
    out = lab.copy()
    q = deque(zip(*np.nonzero(out)))
    while q:
        y, x = q.popleft()
        for dy, dx in STEPS:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not out[ny, nx]:
                out[ny, nx] = out[y, x]
                q.append((ny, nx))
    return out


def save(layer, name):
    """Saves a small 256-colour PNG: exact when the picture has that few colours (the word), otherwise the nearest
    256 (each with its own transparency), which looks the same as the original at a fraction of the weight."""
    flat = layer.reshape(-1, 4)
    colours, index = np.unique(flat, axis=0, return_inverse=True)
    if len(colours) <= 256:
        im = Image.fromarray(index.reshape(layer.shape[:2]).astype(np.uint8), 'P')
        im.putpalette(colours[:, :3].astype(np.uint8).tobytes())
        im.save(os.path.join(OUT, name), optimize=True, transparency=colours[:, 3].astype(np.uint8).tobytes())
    else:
        im = Image.fromarray(layer, 'RGBA').quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        im.save(os.path.join(OUT, name), optimize=True)


def cutout(rgba, keep):
    layer = rgba.copy()
    layer[~keep] = 0
    return layer


def main():
    os.makedirs(OUT, exist_ok=True)
    rgba = np.array(Image.open('brand/logo-mark.png').convert('RGBA'))
    h, w = rgba.shape[:2]
    alpha = rgba[:, :, 3]
    lab, n = components(alpha >= SOLID)
    shapes = []
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        if len(ys) < 50:  # specks: they join their nearest shape below
            lab[lab == i] = 0
            continue
        rgb = rgba[ys, xs, :3].astype(float).mean(0)
        shapes.append({'id': i, 'size': len(ys), 'x0': xs.min(), 'x1': xs.max(), 'y0': ys.min(), 'y1': ys.max(), 'cx': xs.mean(), 'cy': ys.mean(), 'yellow': rgb[0] > rgb[2]})

    # The book: the shapes in the bottom third, left or right of the spine, top stripe (the page) first
    book = [s for s in shapes if s['y0'] > h * 0.6]
    left = sorted([s for s in book if s['cx'] < w / 2], key=lambda s: s['y0'])
    right = sorted([s for s in book if s['cx'] >= w / 2], key=lambda s: s['y0'])
    figures = [s for s in shapes if s not in book]
    student_head = next(s for s in figures if s['yellow'])
    bodies = max(figures, key=lambda s: s['size'])  # both bodies, joined at the hands
    tutor_head = next(s for s in figures if s is not student_head and s is not bodies)
    assert len(left) == 3 and len(right) == 3 and len(figures) == 3, 'the logo no longer has 3 stripes a side and 2 figures; update make-intro.py'

    # Split the bodies at the handshake: everything left of the line through the two notches is the student
    (ax, ay), (bx, by) = [(fx * w, fy * h) for fx, fy in HANDSHAKE]
    yy, xx = np.mgrid[0:h, 0:w]
    side = (bx - ax) * (yy - ay) - (by - ay) * (xx - ax)  # > 0: left of the line (looking from a to b)
    near = (yy > ay - 25) & (yy < by + 25) & (abs(xx - (ax + bx) / 2) < 40)
    body = lab == bodies['id']
    cut = body & ~(near & (abs(side) < (np.hypot(bx - ax, by - ay) * 0.9)))
    parts, k = components(cut)
    sizes = sorted(((parts == i).sum(), i) for i in range(1, k + 1))[-2:]
    a, b = [i for _, i in sizes]
    student_id, tutor_id = (a, b) if np.nonzero(parts == a)[1].mean() < np.nonzero(parts == b)[1].mean() else (b, a)
    student = (parts == student_id) | (body & near & (side > 0) & (parts == 0))
    tutor = body & ~student

    # The final layers (1..10), then every soft edge pixel joins its nearest layer, so the layers add up to the logo
    names = ['book-l1.png', 'book-l2.png', 'book-l3.png', 'book-r1.png', 'book-r2.png', 'book-r3.png', 'tutor.png', 'tutor-head.png', 'student.png', 'student-head.png']
    final = np.zeros((h, w), np.int32)
    for i, s in enumerate(left + right):
        final[lab == s['id']] = i + 1
    final[tutor] = 7
    final[lab == tutor_head['id']] = 8
    final[student] = 9
    final[lab == student_head['id']] = 10
    final = grow(final)
    for i, name in enumerate(names):
        save(cutout(rgba, (final == i + 1) & (alpha > 0)), name)

    # The word: the navy letters of the wordmark (the teal mark sits to their left), cropped tight
    word = np.array(Image.open('brand/logo-wordmark.png').convert('RGBA'))
    navy = (word[:, :, 3] > 0) & (word[:, :, 1].astype(int) < 90)
    navy[:, : int(word.shape[1] * 0.3)] = False
    ys, xs = np.nonzero(navy)
    save(cutout(word, navy)[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1], 'word.png')

    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'intro layers written to {OUT} ({total // 1024} KB); word is {xs.max() - xs.min() + 1}x{ys.max() - ys.min() + 1}')


if __name__ == '__main__':
    main()
