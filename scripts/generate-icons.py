import io
import math
import os
import struct
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PUBLIC_DIR = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(ROOT, "data")
os.makedirs(PUBLIC_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)


def lerp(a, b, t):
    return a + (b - a) * t


def clamp01(v):
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def make_linear_gradient(size, p0, p1, stops):
    """Render an RGBA linear gradient across (size, size) defined by stops [(t, (r,g,b,a)), ...]."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    dx = p1[0] - p0[0]
    dy = p1[1] - p0[1]
    denom = max(1e-6, dx * dx + dy * dy)
    for y in range(size):
        for x in range(size):
            t = clamp01(((x - p0[0]) * dx + (y - p0[1]) * dy) / denom)
            for i in range(len(stops) - 1):
                t0, c0 = stops[i]
                t1, c1 = stops[i + 1]
                if t <= t1 or i == len(stops) - 2:
                    k = clamp01((t - t0) / max(1e-6, t1 - t0))
                    px[x, y] = (
                        int(lerp(c0[0], c1[0], k)),
                        int(lerp(c0[1], c1[1], k)),
                        int(lerp(c0[2], c1[2], k)),
                        int(lerp(c0[3], c1[3], k)),
                    )
                    break
    return img


def draw_thick_segment_mask(size, p0, p1, radius):
    """Draw a round-capped capsule segment onto an L mask."""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    x0, y0 = p0
    x1, y1 = p1
    vx, vy = x1 - x0, y1 - y0
    length = math.hypot(vx, vy)
    if length < 1e-6:
        d.ellipse([x0 - radius, y0 - radius, x0 + radius, y0 + radius], fill=255)
        return mask
    nx, ny = -vy / length * radius, vx / length * radius
    poly = [
        (x0 + nx, y0 + ny),
        (x1 + nx, y1 + ny),
        (x1 - nx, y1 - ny),
        (x0 - nx, y0 - ny),
    ]
    d.polygon(poly, fill=255)
    d.ellipse([x0 - radius, y0 - radius, x0 + radius, y0 + radius], fill=255)
    d.ellipse([x1 - radius, y1 - radius, x1 + radius, y1 + radius], fill=255)
    return mask


def render_master_icon(size=1024, unread_dot=False, full_bleed=False):
    """
    Render AChat 'Obsidian & Cyber Cyan' master icon at 2x internal supersampling
    for razor-sharp diagonal edges from 512px down to 16x16 taskbar size.
    """
    ss = size * 2
    canvas = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))

    margin = 0 if full_bleed else int(ss * 0.055)
    box_x0, box_y0 = margin, margin
    box_x1, box_y1 = ss - margin, ss - margin
    box_w = box_x1 - box_x0
    corner_r = 0 if full_bleed else int(box_w * 0.232)

    # 1. Soft obsidian-cyan drop shadow (desktop/taskbar squircle only)
    if not full_bleed:
        shadow = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
        sdraw = ImageDraw.Draw(shadow)
        sy_off = int(ss * 0.018)
        sdraw.rounded_rectangle(
            [box_x0 + int(ss * 0.01), box_y0 + sy_off, box_x1 - int(ss * 0.01), box_y1 + sy_off],
            radius=corner_r,
            fill=(5, 12, 24, 120),
        )
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=ss * 0.022))
        canvas = Image.alpha_composite(canvas, shadow)

    # 2. Deep Obsidian Micro-Metallic Base (#1B2536 -> #0F1521 -> #080C14)
    # Render gradient at 512px and upscale smoothly for speed
    grad_small = make_linear_gradient(
        384,
        (32, 24),
        (352, 360),
        [
            (0.0, (29, 40, 58, 255)),
            (0.48, (15, 22, 34, 255)),
            (1.0, (8, 12, 20, 255)),
        ],
    ).resize((ss, ss), Image.Resampling.BICUBIC)

    # Subtle ambient cyber-cyan glow in upper-right quadrant
    glow = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gcx, gcy = int(box_x0 + box_w * 0.68), int(box_y0 + box_w * 0.30)
    gr = int(box_w * 0.42)
    gdraw.ellipse([gcx - gr, gcy - gr, gcx + gr, gcy + gr], fill=(14, 165, 233, 52))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=ss * 0.11))
    base_fill = Image.alpha_composite(grad_small, glow)

    # Squircle mask
    sq_mask = Image.new("L", (ss, ss), 0)
    mdraw = ImageDraw.Draw(sq_mask)
    if full_bleed:
        mdraw.rectangle([0, 0, ss, ss], fill=255)
    else:
        mdraw.rounded_rectangle([box_x0, box_y0, box_x1, box_y1], radius=corner_r, fill=255)

    badge = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    badge.paste(base_fill, (0, 0), sq_mask)

    # Crisp specular rim on squircle so dark taskbars (Windows 11 dark mode) still frame the icon cleanly
    if not full_bleed:
        rim = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
        rdraw = ImageDraw.Draw(rim)
        inset = int(ss * 0.005)
        rdraw.rounded_rectangle(
            [box_x0 + inset, box_y0 + inset, box_x1 - inset, box_y1 - inset],
            radius=max(1, corner_r - inset),
            outline=(125, 211, 252, 74),
            width=max(3, int(ss * 0.011)),
        )
        badge = Image.alpha_composite(badge, rim)

    canvas = Image.alpha_composite(canvas, badge)

    def bx(u):
        return box_x0 + box_w * u

    def by(v):
        return box_y0 + box_w * v

    # 3. Precision Geometric 'A' Monogram (Dual-Agent Signal Convergence)
    # Coordinates carefully tuned for unmistakable 'A' silhouette at 16x16 AND sculptural detail at 512x512
    apex = (bx(0.50), by(0.215))
    left_foot = (bx(0.255), by(0.765))
    right_foot = (bx(0.745), by(0.765))
    stroke_r = box_w * 0.064

    # Crossbar: sleek signal bridge connecting inside left leg across to right leg with dynamic cyan energy
    bar_left = (bx(0.355), by(0.575))
    bar_right = (bx(0.665), by(0.575))
    bar_r = box_w * 0.048

    left_leg_mask = draw_thick_segment_mask(ss, left_foot, apex, stroke_r)
    right_leg_mask = draw_thick_segment_mask(ss, apex, right_foot, stroke_r)
    crossbar_mask = draw_thick_segment_mask(ss, bar_left, bar_right, bar_r)

    # Architectural negative-space signal cut: right leg + crossbar cast a crisp obsidian gap over the left leg
    # at the apex/crossbar junction, symbolizing two independent agents (Codex + Antigravity) converging!
    gap_pad = box_w * 0.024
    right_knockout = draw_thick_segment_mask(
        ss,
        (bx(0.525), by(0.271)),
        right_foot,
        stroke_r + gap_pad,
    )
    bar_knockout = draw_thick_segment_mask(
        ss,
        (bx(0.355), by(0.575)),
        (bx(0.50), by(0.575)),
        bar_r + gap_pad * 0.82,
    )

    # Subtract only a clean architectural notch where the cyan crossbar launches from near the left leg,
    # while keeping the apex solidly joined so 16x16 reads as a rock-solid 'A'!
    notch_mask = Image.new("L", (ss, ss), 0)
    ndraw = ImageDraw.Draw(notch_mask)
    # Small parallelogram gap between left white leg and cyan crossbar start
    left_bar_cut = draw_thick_segment_mask(ss, left_foot, apex, stroke_r + box_w * 0.022)
    crossbar_trimmed = ImageChops.subtract(crossbar_mask, left_bar_cut)
    # Re-add union with right leg so right side is seamless
    cyan_union_mask = ImageChops.lighter(right_leg_mask, crossbar_trimmed)

    # Carve a continuous parallel diagonal seam where the right cyan beam launches from the apex
    right_seam_halo = draw_thick_segment_mask(ss, apex, right_foot, stroke_r + box_w * 0.022)
    left_final_mask = ImageChops.subtract(left_leg_mask, right_seam_halo)

    # Subtle drop shadow behind the 'A' monogram
    glyph_union = ImageChops.lighter(left_final_mask, cyan_union_mask)
    g_shadow = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    g_shadow_fill = Image.new("RGBA", (ss, ss), (2, 6, 14, 150))
    g_shadow.paste(g_shadow_fill, (0, int(ss * 0.016)), glyph_union)
    g_shadow = g_shadow.filter(ImageFilter.GaussianBlur(radius=ss * 0.016))
    g_shadow_clipped = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    g_shadow_clipped.paste(g_shadow, (0, 0), sq_mask)
    canvas = Image.alpha_composite(canvas, g_shadow_clipped)

    # Left Leg Fill: Crisp Ice-Platinum White (#FFFFFF -> #DCE7F5)
    white_grad = make_linear_gradient(
        256,
        (64, 48),
        (140, 210),
        [
            (0.0, (255, 255, 255, 255)),
            (0.65, (241, 245, 249, 255)),
            (1.0, (203, 213, 225, 255)),
        ],
    ).resize((ss, ss), Image.Resampling.BICUBIC)
    left_layer = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    left_layer.paste(white_grad, (0, 0), left_final_mask)
    canvas = Image.alpha_composite(canvas, left_layer)

    # Right Leg + Signal Crossbar Fill: Luminous Cyber Cyan (#7DD3FC -> #38BDF8 -> #0284C7)
    cyan_grad = make_linear_gradient(
        256,
        (110, 48),
        (196, 206),
        [
            (0.0, (125, 211, 252, 255)),
            (0.45, (56, 189, 248, 255)),
            (1.0, (2, 132, 199, 255)),
        ],
    ).resize((ss, ss), Image.Resampling.BICUBIC)
    cyan_layer = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    cyan_layer.paste(cyan_grad, (0, 0), cyan_union_mask)
    canvas = Image.alpha_composite(canvas, cyan_layer)

    # 4. Optional Unread Notification Dot (for Windows System Tray unread alert)
    if unread_dot:
        dot_layer = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
        ddraw = ImageDraw.Draw(dot_layer)
        dcx, dcy = int(ss * 0.82), int(ss * 0.18)
        dr_outer = int(ss * 0.155)
        dr_inner = int(ss * 0.122)
        ddraw.ellipse([dcx - dr_outer, dcy - dr_outer, dcx + dr_outer, dcy + dr_outer], fill=(15, 22, 34, 255))
        ddraw.ellipse([dcx - dr_inner, dcy - dr_inner, dcx + dr_inner, dcy + dr_inner], fill=(244, 63, 94, 255))
        canvas = Image.alpha_composite(canvas, dot_layer)

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def build_ico_bytes(master_img, sizes=(16, 24, 32, 48, 64, 128, 256)):
    """Build a genuine multi-resolution PNG-compressed Windows 11 .ico file."""
    entries = []
    for s in sizes:
        resized = master_img.resize((s, s), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        resized.save(buf, format="PNG", optimize=True)
        entries.append((s, buf.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_bytes = bytearray()
    payload = bytearray()

    for s, png_data in entries:
        w_byte = 0 if s >= 256 else s
        h_byte = 0 if s >= 256 else s
        dir_bytes.extend(
            struct.pack(
                "<BBBBHHII",
                w_byte,
                h_byte,
                0,
                0,
                1,
                32,
                len(png_data),
                offset,
            )
        )
        payload.extend(png_data)
        offset += len(png_data)

    return bytes(header) + bytes(dir_bytes) + bytes(payload)


def main():
    master = render_master_icon(size=1024, unread_dot=False, full_bleed=False)
    master_unread = render_master_icon(size=1024, unread_dot=True, full_bleed=False)
    master_full_bleed = render_master_icon(size=512, unread_dot=False, full_bleed=True)

    # Save PNG sizes for Electron, PWA, Android & favicon
    master.resize((512, 512), Image.Resampling.LANCZOS).save(
        os.path.join(PUBLIC_DIR, "icon-512.png"), format="PNG", optimize=True
    )
    master.resize((192, 192), Image.Resampling.LANCZOS).save(
        os.path.join(PUBLIC_DIR, "icon-192.png"), format="PNG", optimize=True
    )
    master.resize((64, 64), Image.Resampling.LANCZOS).save(
        os.path.join(PUBLIC_DIR, "icon-64.png"), format="PNG", optimize=True
    )
    master_unread.resize((64, 64), Image.Resampling.LANCZOS).save(
        os.path.join(PUBLIC_DIR, "icon-unread-64.png"), format="PNG", optimize=True
    )
    master_full_bleed.save(
        os.path.join(DATA_DIR, "android-icon-master.png"), format="PNG", optimize=True
    )

    # Save multi-size Windows .ico (write BOTH achat.ico to bust Windows Explorer IconCache AND icon.ico)
    ico_bytes = build_ico_bytes(master)
    for name in ("achat.ico", "icon.ico"):
        with open(os.path.join(PUBLIC_DIR, name), "wb") as f:
            f.write(ico_bytes)

    ico_unread_bytes = build_ico_bytes(master_unread, sizes=(16, 24, 32, 48))
    for name in ("achat-unread.ico", "icon-unread.ico"):
        with open(os.path.join(PUBLIC_DIR, name), "wb") as f:
            f.write(ico_unread_bytes)

    # Save matching crisp vector SVG for browser tab & scalable UI
    svg_text = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="acBg" x1="8%" y1="6%" x2="92%" y2="94%">
      <stop offset="0%" stop-color="#1D283A"/>
      <stop offset="48%" stop-color="#0F1622"/>
      <stop offset="100%" stop-color="#080C14"/>
    </linearGradient>
    <radialGradient id="acGlow" cx="68%" cy="28%" r="48%">
      <stop offset="0%" stop-color="#0EA5E9" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#0EA5E9" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="acWhite" x1="25%" y1="18%" x2="52%" y2="82%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="65%" stop-color="#F1F5F9"/>
      <stop offset="100%" stop-color="#CBD5E1"/>
    </linearGradient>
    <linearGradient id="acCyan" x1="45%" y1="18%" x2="80%" y2="82%">
      <stop offset="0%" stop-color="#7DD3FC"/>
      <stop offset="45%" stop-color="#38BDF8"/>
      <stop offset="100%" stop-color="#0284C7"/>
    </linearGradient>
    <mask id="leftTrim">
      <rect width="256" height="256" fill="#FFFFFF"/>
      <line x1="128" y1="63" x2="184" y2="190" stroke="#000000" stroke-width="39" stroke-linecap="round"/>
    </mask>
    <mask id="barTrim">
      <rect width="256" height="256" fill="#FFFFFF"/>
      <line x1="72" y1="190" x2="128" y2="63" stroke="#000000" stroke-width="39" stroke-linecap="round"/>
    </mask>
  </defs>
  <rect x="14" y="14" width="228" height="228" rx="53" fill="url(#acBg)"/>
  <rect x="14" y="14" width="228" height="228" rx="53" fill="url(#acGlow)"/>
  <rect x="15.5" y="15.5" width="225" height="225" rx="51.5" fill="none" stroke="#7DD3FC" stroke-opacity="0.28" stroke-width="2.5"/>
  <!-- Left Platinum Leg -->
  <line x1="72" y1="190" x2="128" y2="63" stroke="url(#acWhite)" stroke-width="29" stroke-linecap="round" mask="url(#leftTrim)"/>
  <!-- Cyber Cyan Signal Crossbar -->
  <line x1="95" y1="146" x2="166" y2="146" stroke="url(#acCyan)" stroke-width="22" stroke-linecap="round" mask="url(#barTrim)"/>
  <!-- Right Cyber Cyan Leg -->
  <line x1="128" y1="63" x2="184" y2="190" stroke="url(#acCyan)" stroke-width="29" stroke-linecap="round"/>
</svg>
"""
    with open(os.path.join(PUBLIC_DIR, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(svg_text)

    # Generate side-by-side QA preview sheet on BOTH light desktop and dark Windows 11 taskbar backgrounds
    sheet = Image.new("RGBA", (620, 320), (241, 245, 249, 255))
    sdraw = ImageDraw.Draw(sheet)
    sdraw.rounded_rectangle([296, 166, 604, 304], radius=12, fill=(17, 24, 39, 255))
    sheet.alpha_composite(master.resize((256, 256), Image.Resampling.LANCZOS), (20, 32))
    # Light background row (64, 32, 16, unread 32)
    sheet.alpha_composite(master.resize((64, 64), Image.Resampling.LANCZOS), (312, 36))
    sheet.alpha_composite(master.resize((32, 32), Image.Resampling.LANCZOS), (402, 52))
    sheet.alpha_composite(master.resize((16, 16), Image.Resampling.LANCZOS), (460, 60))
    sheet.alpha_composite(master_unread.resize((32, 32), Image.Resampling.LANCZOS), (506, 52))
    # Dark taskbar row (64, 32, 16, unread 24)
    sheet.alpha_composite(master.resize((64, 64), Image.Resampling.LANCZOS), (312, 202))
    sheet.alpha_composite(master.resize((32, 32), Image.Resampling.LANCZOS), (402, 218))
    sheet.alpha_composite(master.resize((16, 16), Image.Resampling.LANCZOS), (460, 226))
    sheet.alpha_composite(master_unread.resize((24, 24), Image.Resampling.LANCZOS), (506, 222))

    preview_out = os.path.join(DATA_DIR, "icon-qa-sheet.png")
    sheet.save(preview_out, format="PNG")
    print("Generated AChat icons successfully:", len(ico_bytes), "bytes (achat.ico)")


if __name__ == "__main__":
    main()
