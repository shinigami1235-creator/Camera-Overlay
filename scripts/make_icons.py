"""Crop the Cygnus swan glyph out of the Aesthetics lockup (drop the wordmark)
and generate the PWA icon set for Camera Overlay, using the Cygnus Solutions
navy/gold tokens.
"""
from PIL import Image
import os

SRC = "/mnt/user-data/uploads/Logo and Tokens/Cygnus_Aesthetics-removebg-preview.png"
OUT_DIR = "/home/claude/camera-overlay/icons"
os.makedirs(OUT_DIR, exist_ok=True)

NAVY = (15, 28, 43, 255)      # --cs-primary-700 #0F3A62... actually let's use --cs-brand-navy
NAVY = (16, 28, 43, 255)      # --cs-brand-navy #101C2B
GOLD = (200, 154, 60, 255)    # --cs-brand-gold #C89A3C

im = Image.open(SRC).convert("RGBA")
w, h = im.size
print("source size", w, h)

# Find alpha bounding box of just the swan glyph (top ~62% of the image,
# above where the wordmark text starts) so we don't grab "AESTHETICS".
glyph_region = im.crop((0, 0, w, int(h * 0.62)))
alpha = glyph_region.split()[3]
bbox = alpha.getbbox()
print("glyph bbox", bbox)
glyph = glyph_region.crop(bbox)

# Pad to a square canvas, glyph centered, with a small margin.
gw, gh = glyph.size
side = int(max(gw, gh) * 1.35)
square_transparent = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square_transparent.alpha_composite(glyph, ((side - gw) // 2, (side - gh) // 2))

def save_sized(base_img, size, path):
    resized = base_img.resize((size, size), Image.LANCZOS)
    resized.save(path)
    print("wrote", path, resized.size)

# --- Transparent "any" icons (maskable:false) ---
save_sized(square_transparent, 192, f"{OUT_DIR}/icon-192.png")
save_sized(square_transparent, 512, f"{OUT_DIR}/icon-512.png")

# --- Maskable icons: solid navy background, glyph inset into the safe zone
# (icon masks can crop up to ~20% off each edge, so keep the glyph within
# the inner ~80% circle). ---
def make_maskable(size):
    canvas = Image.new("RGBA", (size, size), NAVY)
    safe = int(size * 0.68)  # glyph occupies the safe zone, comfortably inside the mask circle
    glyph_resized = glyph.resize(
        (safe, int(safe * gh / gw)) if gw >= gh else (int(safe * gw / gh), safe),
        Image.LANCZOS,
    )
    gx = (size - glyph_resized.width) // 2
    gy = (size - glyph_resized.height) // 2
    canvas.alpha_composite(glyph_resized, (gx, gy))
    return canvas

save_sized(make_maskable(512), 512, f"{OUT_DIR}/icon-maskable-512.png")
save_sized(make_maskable(192), 192, f"{OUT_DIR}/icon-maskable-192.png")

# --- apple-touch-icon: iOS ignores alpha and fills transparent with black,
# so give it the same solid navy treatment (no rounded corners needed, iOS
# applies its own mask). ---
apple = make_maskable(180)
apple.convert("RGB").save(f"{OUT_DIR}/apple-touch-icon.png")
print("wrote apple-touch-icon.png", apple.size)

# --- favicon ---
save_sized(square_transparent, 48, f"{OUT_DIR}/favicon-48.png")

print("done")
