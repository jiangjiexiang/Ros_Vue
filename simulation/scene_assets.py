"""
高写实工业巡检仿真资产生成器（纯本地离线 PBR 纹理 + 多部件 USD 工业设备建模）
- 零云端依赖，首次自动生成并缓存高分辨率 PBR 贴图至 simulation/textures/
- 使用显式 UV (primvars:st) 的 UsdGeom.Mesh + UsdPreviewSurface（含漫反射/粗糙度/金属度/自发光）
- 区分障碍 (/World/Environment)、可通行坡面 (/World/Traversable) 与装饰 (/World/Decor)，Nav2 仅使用障碍云，FAST-LIO 使用完整点云
"""

import fcntl
import math
import os
import re
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import isaaclab.sim as sim_utils
from pxr import Gf, Sdf, UsdGeom, UsdLux, UsdPhysics, UsdShade, Vt

TEXTURE_DIR = Path(__file__).resolve().parent / "textures"
TEXTURE_VERSION = "v2_industrial_inspection"

FONT_BOLD_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _font(size: int, bold: bool = True):
    for p in (FONT_BOLD_CANDIDATES if bold else FONT_REG_CANDIDATES):
        if Path(p).is_file():
            try:
                if p.endswith(".ttc"):
                    return ImageFont.truetype(p, size, index=2)
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _smooth_noise(h: int, w: int, seed: int = 42, scale: int = 16) -> np.ndarray:
    rng = np.random.default_rng(seed)
    gh = max(2, h // scale)
    gw = max(2, w // scale)
    grid = rng.random((gh, gw), dtype=np.float32)
    img = Image.fromarray((grid * 255).astype(np.uint8)).resize((w, h), Image.Resampling.BILINEAR)
    return np.asarray(img, dtype=np.float32) / 255.0


def _draw_hazard_strip(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int, step: int = 38):
    draw.rectangle([x0, y0, x1, y1], fill=(28, 30, 34))
    h = y1 - y0
    for x in range(x0 - h - step, x1 + step, step):
        poly = [(x, y1), (x + step // 2, y1), (x + step // 2 + h, y0), (x + h, y0)]
        draw.polygon(poly, fill=(238, 184, 18))
    draw.rectangle([x0, y0, x1, y1], outline=(20, 22, 26), width=2)


def _draw_analog_gauge(draw: ImageDraw.ImageDraw, cx: int, cy: int, r: int, needle_deg: float, title: str, unit: str, warn: bool = False):
    # Bezel
    draw.ellipse([cx - r - 6, cy - r - 6, cx + r + 6, cy + r + 6], fill=(32, 37, 44), outline=(120, 132, 145), width=3)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(238, 242, 246), outline=(50, 58, 66), width=2)
    # Green & red arc sectors
    draw.pieslice([cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8], 135, 340, fill=(215, 242, 225))
    draw.pieslice([cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8], 340, 405, fill=(252, 205, 205))
    draw.ellipse([cx - int(r * 0.78), cy - int(r * 0.78), cx + int(r * 0.78), cy + int(r * 0.78)], fill=(242, 245, 248))
    # Tick marks
    for i in range(11):
        ang = math.radians(135 + i * 27.0)
        x_out = cx + (r - 8) * math.cos(ang)
        y_out = cy + (r - 8) * math.sin(ang)
        x_in = cx + (r - (20 if i % 2 == 0 else 14)) * math.cos(ang)
        y_in = cy + (r - (20 if i % 2 == 0 else 14)) * math.sin(ang)
        col = (210, 40, 40) if i >= 8 else (30, 36, 44)
        draw.line([(x_in, y_in), (x_out, y_out)], fill=col, width=3 if i % 2 == 0 else 2)
    # Labels
    f_sm = _font(max(14, r // 4), bold=True)
    tb = draw.textbbox((0, 0), title, font=f_sm)
    draw.text((cx - (tb[2] - tb[0]) // 2, cy - r // 2), title, font=f_sm, fill=(35, 42, 52))
    ub = draw.textbbox((0, 0), unit, font=f_sm)
    draw.text((cx - (ub[2] - ub[0]) // 2, cy + r // 3), unit, font=f_sm, fill=(200, 45, 45) if warn else (40, 90, 65))
    # Needle
    n_ang = math.radians(needle_deg)
    nx = cx + (r - 16) * math.cos(n_ang)
    ny = cy + (r - 16) * math.sin(n_ang)
    draw.line([(cx, cy), (nx, ny)], fill=(220, 32, 32), width=4)
    draw.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], fill=(28, 32, 38))


def _atomic_save_image(image: Image.Image, path: Path):
    temporary = tempfile.NamedTemporaryFile(
        prefix=f".{path.stem}.", suffix=path.suffix, dir=path.parent, delete=False
    )
    try:
        with temporary:
            image.save(temporary, format="PNG")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary.name, path)
    except Exception:
        Path(temporary.name).unlink(missing_ok=True)
        raise


def _atomic_write_text(path: Path, content: str):
    temporary = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", prefix=f".{path.name}.", dir=path.parent, delete=False
    )
    try:
        with temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary.name, path)
    except Exception:
        Path(temporary.name).unlink(missing_ok=True)
        raise


def ensure_textures() -> dict[str, str]:
    TEXTURE_DIR.mkdir(parents=True, exist_ok=True)
    with open(TEXTURE_DIR / ".generation.lock", "a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        return _ensure_textures_locked()


def _ensure_textures_locked() -> dict[str, str]:
    TEXTURE_DIR.mkdir(parents=True, exist_ok=True)
    stamp_file = TEXTURE_DIR / ".version"
    names = [
        "epoxy_floor.png",
        "epoxy_roughness.png",
        "brick_wall.png",
        "yellow_cladding.png",
        "switchgear_hv.png",
        "thermal_cabinet.png",
        "server_rack.png",
        "fire_cabinet.png",
        "gauge_dial.png",
        "sign_hv.png",
        "sign_patrol.png",
        "sign_safety.png",
        "cardboard_box.png",
        "wood_pallet.png",
        "hazard_stripe.png",
        "asphalt_road.png",
        "concrete_slab.png",
        "monitor_screen.png",
        "patrol_pad.png",
    ]
    if stamp_file.is_file() and stamp_file.read_text(encoding="utf-8").strip() == TEXTURE_VERSION:
        if all((TEXTURE_DIR / n).is_file() for n in names):
            return {n: str(TEXTURE_DIR / n) for n in names}

    # 1. Scuffed industrial blue-slate epoxy floor (1024x1024 tileable) + roughness
    sz = 1024
    n1 = _smooth_noise(sz, sz, seed=11, scale=64)
    n2 = _smooth_noise(sz, sz, seed=22, scale=16)
    n3 = _smooth_noise(sz, sz, seed=33, scale=4)
    blend = 0.55 * n1 + 0.30 * n2 + 0.15 * n3
    base_r = np.clip(54 + (blend - 0.5) * 30, 30, 105)
    base_g = np.clip(74 + (blend - 0.5) * 34, 42, 128)
    base_b = np.clip(92 + (blend - 0.5) * 36, 54, 148)
    floor_arr = np.stack([base_r, base_g, base_b], axis=-1).astype(np.uint8)
    floor_img = Image.fromarray(floor_arr)
    fd = ImageDraw.Draw(floor_img)
    # Concrete slab expansion joints (2x2 tiles per texture)
    for pos in (0, 512):
        fd.line([(pos, 0), (pos, sz)], fill=(38, 52, 66), width=5)
        fd.line([(pos + 4, 0), (pos + 4, sz)], fill=(86, 108, 128), width=2)
        fd.line([(0, pos), (sz, pos)], fill=(38, 52, 66), width=5)
        fd.line([(0, pos + 4), (sz, pos + 4)], fill=(86, 108, 128), width=2)
    _atomic_save_image(floor_img, TEXTURE_DIR / "epoxy_floor.png")

    rough = np.clip(75 + (blend - 0.5) * 85, 35, 175).astype(np.uint8)
    _atomic_save_image(Image.fromarray(rough, mode="L"), TEXTURE_DIR / "epoxy_roughness.png")

    # 2. Industrial painted white-grey brick wall (1024x1024)
    w_n = _smooth_noise(1024, 1024, seed=41, scale=12)
    brick_arr = np.full((1024, 1024, 3), 224, dtype=np.float32)
    brick_arr += (w_n[:, :, None] - 0.5) * 20
    brick_img = Image.fromarray(np.clip(brick_arr, 175, 245).astype(np.uint8))
    bd = ImageDraw.Draw(brick_img)
    row_h, brick_w = 32, 96
    for row in range(0, 920 // row_h):
        y = row * row_h
        bd.line([(0, y), (1024, y)], fill=(182, 188, 194), width=3)
        offset = (brick_w // 2) if (row % 2 == 1) else 0
        for x in range(offset, 1024, brick_w):
            bd.line([(x, y), (x, y + row_h)], fill=(182, 188, 194), width=3)
    # Dark industrial steel baseboard plinth at bottom of wall (in USD UV v=0 is bottom -> PIL y=bottom!)
    bd.rectangle([0, 916, 1024, 1024], fill=(64, 72, 82))
    bd.line([(0, 916), (1024, 916)], fill=(42, 48, 56), width=6)
    # Subtle yellow-grey safety rail stripe
    bd.rectangle([0, 886, 1024, 908], fill=(224, 176, 36))
    _atomic_save_image(brick_img, TEXTURE_DIR / "brick_wall.png")

    # 3. Corrugated industrial safety-yellow upper wall cladding (512x512)
    yc = Image.new("RGB", (512, 512), (228, 176, 22))
    yd = ImageDraw.Draw(yc)
    for x in range(0, 512, 32):
        yd.rectangle([x, 0, x + 8, 512], fill=(202, 152, 14))
        yd.rectangle([x + 8, 0, x + 12, 512], fill=(244, 198, 48))
    yd.rectangle([0, 488, 512, 512], fill=(74, 82, 92))
    _atomic_save_image(yc, TEXTURE_DIR / "yellow_cladding.png")

    # 4. 10kV HV Switchgear Cabinet Front (1024x1024)
    sw = Image.new("RGB", (1024, 1024), (72, 82, 94))
    sd = ImageDraw.Draw(sw)
    # Subtle brushed steel noise
    sn = (_smooth_noise(1024, 1024, seed=55, scale=8) - 0.5) * 14
    sw = Image.fromarray(np.clip(np.asarray(sw, dtype=np.float32) + sn[:, :, None], 40, 120).astype(np.uint8))
    sd = ImageDraw.Draw(sw)
    # Outer door recess & inner panel frame
    sd.rectangle([20, 20, 1004, 1004], outline=(34, 40, 48), width=10)
    sd.rectangle([38, 38, 986, 986], outline=(105, 118, 132), width=3)
    # Header nameplate
    sd.rectangle([60, 54, 964, 134], fill=(22, 36, 54), outline=(140, 160, 180), width=3)
    sd.text((90, 74), "10kV 高压主配电柜  |  HV-SWITCHGEAR #01", font=_font(36, True), fill=(240, 246, 252))
    # 3 Analog gauges
    _draw_analog_gauge(sd, 200, 270, 96, 255, "电压 kV", "10.2 kV")
    _draw_analog_gauge(sd, 440, 270, 96, 290, "电流 A", "148 A")
    _draw_analog_gauge(sd, 680, 270, 96, 235, "温度 °C", "42.6 °C")
    # Digital LCD telemetry screen
    sd.rectangle([800, 166, 964, 372], fill=(10, 28, 26), outline=(110, 126, 140), width=4)
    sd.text((818, 182), "SYS OK", font=_font(26, True), fill=(40, 238, 140))
    sd.text((818, 224), "380.4 V", font=_font(24, True), fill=(56, 220, 245))
    sd.text((818, 264), "50.0 Hz", font=_font(24, True), fill=(56, 220, 245))
    sd.text((818, 304), "42.6 °C", font=_font(24, True), fill=(250, 205, 65))
    # Status indicator lamps + E-stop + rotary switches
    for idx, (col, lbl) in enumerate([((36, 225, 105), "运行"), ((245, 190, 25), "待机"), ((225, 45, 45), "告警")]):
        cx = 160 + idx * 140
        sd.ellipse([cx - 26, 420 - 26, cx + 26, 420 + 26], fill=col, outline=(24, 28, 32), width=4)
        sd.text((cx - 20, 456), lbl, font=_font(22, True), fill=(232, 238, 244))
    # Red emergency stop button
    sd.rectangle([580, 392, 680, 492], fill=(238, 192, 24), outline=(30, 34, 38), width=3)
    sd.ellipse([600, 412, 660, 472], fill=(220, 32, 32), outline=(140, 18, 18), width=4)
    # Stainless steel door handle
    sd.rounded_rectangle([882, 460, 944, 650], radius=10, fill=(40, 46, 54), outline=(160, 172, 184), width=3)
    sd.rounded_rectangle([898, 488, 928, 622], radius=6, fill=(186, 196, 208))
    # High-voltage warning sign
    sd.rectangle([80, 520, 430, 690], fill=(242, 192, 20), outline=(22, 24, 28), width=6)
    sd.polygon([(155, 542), (105, 668), (205, 668)], fill=(242, 192, 20), outline=(22, 24, 28))
    sd.line([(155, 542), (105, 668), (205, 668), (155, 542)], fill=(22, 24, 28), width=6)
    sd.polygon([(158, 570), (138, 616), (158, 616), (144, 654), (176, 606), (156, 606)], fill=(215, 30, 30))
    sd.text((224, 560), "高压危险", font=_font(44, True), fill=(20, 22, 26))
    sd.text((224, 620), "止步 · 巡检设备", font=_font(24, True), fill=(20, 22, 26))
    # Ventilation louvers
    for ly in range(728, 886, 22):
        sd.rectangle([80, ly, 840, ly + 10], fill=(32, 38, 46))
        sd.line([(80, ly + 11), (840, ly + 11)], fill=(104, 116, 128), width=2)
    # Hazard kickplate
    _draw_hazard_strip(sd, 40, 916, 984, 984, step=46)
    _atomic_save_image(sw, TEXTURE_DIR / "switchgear_hv.png")

    # 5. Thermal Monitoring Cabinet Front (1024x1024)
    tc = Image.new("RGB", (1024, 1024), (66, 78, 92))
    td = ImageDraw.Draw(tc)
    td.rectangle([20, 20, 1004, 1004], outline=(30, 36, 44), width=10)
    td.rectangle([56, 54, 968, 134], fill=(24, 46, 68), outline=(145, 165, 185), width=3)
    td.text((86, 74), "智能温控监测柜  |  THERMAL CTRL #02", font=_font(36, True), fill=(240, 246, 252))
    _draw_analog_gauge(td, 240, 280, 105, 325, "主变温 °C", "68.5 °C", warn=True)
    _draw_analog_gauge(td, 510, 280, 105, 240, "油压 MPa", "0.42 MPa")
    # Thermal screen
    td.rectangle([660, 174, 960, 410], fill=(16, 20, 38), outline=(120, 136, 154), width=4)
    td.text((682, 190), "IR THERMAL LIVE", font=_font(22, True), fill=(250, 195, 50))
    for i, h_bar in enumerate([90, 130, 155, 110, 78, 142]):
        bx = 684 + i * 44
        col = (240, 68, 48) if h_bar > 135 else (245, 178, 36) if h_bar > 105 else (42, 210, 148)
        td.rectangle([bx, 385 - h_bar, bx + 28, 385], fill=col)
    # Louvers & handle & hazard base
    td.rounded_rectangle([886, 480, 944, 660], radius=10, fill=(40, 46, 54), outline=(165, 178, 192), width=3)
    td.rounded_rectangle([902, 508, 928, 632], radius=6, fill=(192, 202, 214))
    for ly in range(470, 880, 24):
        td.rectangle([76, ly, 830, ly + 11], fill=(34, 40, 48))
    _draw_hazard_strip(td, 40, 916, 984, 984, step=46)
    _atomic_save_image(tc, TEXTURE_DIR / "thermal_cabinet.png")

    # 6. 42U Industrial Server Rack Front (1024x1024)
    sr = Image.new("RGB", (1024, 1024), (24, 29, 36))
    srd = ImageDraw.Draw(sr)
    srd.rectangle([16, 16, 1008, 1008], outline=(62, 72, 86), width=12)
    srd.rectangle([48, 36, 976, 104], fill=(16, 38, 58), outline=(56, 189, 248), width=3)
    srd.text((78, 50), "东区服务器机柜  |  SERVER RACK E-01", font=_font(34, True), fill=(125, 232, 255))
    rng = np.random.default_rng(88)
    for slot in range(11):
        y0 = 124 + slot * 76
        y1 = y0 + 62
        srd.rectangle([58, y0, 966, y1], fill=(34, 40, 50), outline=(68, 78, 92), width=2)
        # Drive bays
        for bay in range(6):
            bx = 76 + bay * 104
            srd.rectangle([bx, y0 + 10, bx + 92, y1 - 10], fill=(22, 26, 33), outline=(58, 66, 78), width=1)
            # Activity LEDs
            led_col = (34, 224, 130) if rng.random() > 0.22 else (56, 189, 248)
            srd.rectangle([bx + 8, y0 + 18, bx + 20, y0 + 26], fill=led_col)
            if rng.random() > 0.45:
                srd.rectangle([bx + 26, y0 + 18, bx + 36, y0 + 26], fill=(245, 190, 35))
        # Right status block + cyan fiber ports
        srd.rectangle([718, y0 + 10, 948, y1 - 10], fill=(18, 28, 40), outline=(52, 80, 104), width=1)
        for p in range(5):
            px = 736 + p * 38
            srd.ellipse([px, y0 + 22, px + 14, y0 + 36], fill=(36, 215, 245) if p % 2 == 0 else (42, 228, 128))
    _draw_hazard_strip(srd, 48, 962, 976, 994, step=32)
    _atomic_save_image(sr, TEXTURE_DIR / "server_rack.png")

    # 7. Red Fire Hydrant Cabinet Front (512x1024)
    fc = Image.new("RGB", (512, 1024), (186, 28, 28))
    fcd = ImageDraw.Draw(fc)
    fcd.rectangle([16, 16, 496, 1008], outline=(112, 14, 14), width=10)
    fcd.rectangle([38, 42, 474, 152], fill=(154, 18, 18), outline=(245, 245, 245), width=3)
    fcd.text((132, 54), "消 防 栓", font=_font(54, True), fill=(252, 252, 252))
    fcd.text((112, 114), "FIRE HYDRANT", font=_font(30, True), fill=(252, 236, 236))
    # Glass window with coiled hose reel silhouette
    fcd.rectangle([58, 196, 454, 650], fill=(38, 46, 54), outline=(235, 238, 242), width=6)
    fcd.ellipse([116, 260, 396, 540], fill=(215, 210, 196), outline=(140, 134, 122), width=8)
    fcd.ellipse([168, 312, 344, 488], fill=(185, 32, 32), outline=(115, 16, 16), width=6)
    fcd.ellipse([226, 370, 286, 430], fill=(224, 182, 46))
    # Handle & bottom warning
    fcd.rounded_rectangle([408, 690, 454, 820], radius=8, fill=(215, 220, 228), outline=(70, 74, 80), width=3)
    fcd.text((88, 720), "应急消防阀门", font=_font(38, True), fill=(252, 252, 252))
    fcd.text((88, 778), "严禁遮挡 · 定期巡检", font=_font(28, True), fill=(255, 230, 140))
    _draw_hazard_strip(fcd, 32, 916, 480, 984, step=36)
    _atomic_save_image(fc, TEXTURE_DIR / "fire_cabinet.png")

    # 8. Circular Pressure Gauge Texture (512x512)
    gd = Image.new("RGB", (512, 512), (38, 44, 52))
    _draw_analog_gauge(ImageDraw.Draw(gd), 256, 256, 224, 275, "管网压力", "0.78 MPa")
    _atomic_save_image(gd, TEXTURE_DIR / "gauge_dial.png")

    # 9. Wall Safety Signs (1024x512)
    def make_sign(fname, bg, border, title, sub, accent):
        im = Image.new("RGB", (1024, 512), bg)
        dr = ImageDraw.Draw(im)
        dr.rectangle([16, 16, 1008, 496], outline=border, width=14)
        dr.rectangle([40, 40, 984, 152], fill=accent)
        dr.text((76, 64), title, font=_font(56, True), fill=(20, 22, 26) if accent[0] > 180 else (248, 250, 252))
        dr.text((76, 206), sub, font=_font(44, True), fill=(24, 28, 34) if bg[0] > 180 else (238, 244, 250))
        _draw_hazard_strip(dr, 40, 404, 984, 472, step=48)
        _atomic_save_image(im, TEXTURE_DIR / fname)

    make_sign("sign_hv.png", (245, 246, 248), (22, 24, 28), "⚡ 高压配电重地 · HIGH VOLTAGE", "智能四足机器人自动巡检区 · 严禁非运维人员入内", (242, 192, 22))
    make_sign("sign_patrol.png", (18, 38, 62), (56, 189, 248), "智能无人巡检示范区 · GO2 PATROL", "配电测温 · 仪表读数 · 消防管网安全监测", (14, 116, 144))
    make_sign("sign_safety.png", (22, 92, 54), (242, 248, 244), "安全通道 · SAFETY AISLE", "请保持通道畅通 · 严禁堆放杂物与遮挡消防设施", (16, 142, 74))

    # 10. Cardboard shipping box (512x512)
    cn = (_smooth_noise(512, 512, seed=71, scale=8) - 0.5) * 24
    cb_arr = np.stack([182 + cn, 138 + cn * 0.85, 88 + cn * 0.65], axis=-1)
    cb = Image.fromarray(np.clip(cb_arr, 90, 225).astype(np.uint8))
    cbd = ImageDraw.Draw(cb)
    cbd.rectangle([10, 10, 502, 502], outline=(118, 84, 48), width=6)
    cbd.rectangle([232, 10, 280, 502], fill=(214, 188, 142))
    cbd.rectangle([44, 340, 210, 464], fill=(242, 242, 238), outline=(50, 50, 50), width=3)
    for bx in range(60, 196, 8):
        cbd.rectangle([bx, 408, bx + (4 if bx % 16 == 0 else 2), 450], fill=(24, 24, 24))
    cbd.text((62, 354), "INDUSTRIAL", font=_font(22, True), fill=(30, 30, 30))
    cbd.text((62, 380), "PART #A-402", font=_font(18, True), fill=(60, 60, 60))
    _atomic_save_image(cb, TEXTURE_DIR / "cardboard_box.png")

    # 11. Wood pallet (512x512)
    wn = (_smooth_noise(512, 512, seed=77, scale=6) - 0.5) * 26
    wp_arr = np.stack([166 + wn, 126 + wn * 0.85, 82 + wn * 0.6], axis=-1)
    wp = Image.fromarray(np.clip(wp_arr, 70, 210).astype(np.uint8))
    wpd = ImageDraw.Draw(wp)
    for y in range(0, 512, 85):
        wpd.rectangle([0, y, 512, y + 10], fill=(82, 58, 34))
    _atomic_save_image(wp, TEXTURE_DIR / "wood_pallet.png")

    # 12. Hazard stripe texture (512x512)
    hz = Image.new("RGB", (512, 512), (28, 30, 34))
    _draw_hazard_strip(ImageDraw.Draw(hz), 0, 0, 512, 512, step=64)
    _atomic_save_image(hz, TEXTURE_DIR / "hazard_stripe.png")

    # 13. Asphalt road (1024x1024)
    an1 = _smooth_noise(1024, 1024, seed=91, scale=4)
    an2 = _smooth_noise(1024, 1024, seed=92, scale=32)
    ab = 0.55 * an1 + 0.45 * an2
    asph = np.stack([56 + ab * 34, 60 + ab * 34, 64 + ab * 34], axis=-1)
    _atomic_save_image(Image.fromarray(np.clip(asph, 35, 115).astype(np.uint8)), TEXTURE_DIR / "asphalt_road.png")

    # 14. Concrete slab (512x512)
    csn = 0.5 * _smooth_noise(512, 512, seed=95, scale=8) + 0.5 * _smooth_noise(512, 512, seed=96, scale=32)
    cs = np.stack([152 + csn * 36, 155 + csn * 36, 158 + csn * 36], axis=-1)
    cs_img = Image.fromarray(np.clip(cs, 115, 210).astype(np.uint8))
    ImageDraw.Draw(cs_img).rectangle([4, 4, 508, 508], outline=(105, 108, 112), width=6)
    _atomic_save_image(cs_img, TEXTURE_DIR / "concrete_slab.png")

    # 15. Control workstation monitor screen (512x256)
    ms = Image.new("RGB", (512, 256), (10, 22, 38))
    msd = ImageDraw.Draw(ms)
    msd.rectangle([8, 8, 504, 248], outline=(34, 211, 238), width=3)
    msd.text((24, 22), "SCADA 工业配电监控系统", font=_font(24, True), fill=(56, 216, 248))
    for i, val in enumerate([0.62, 0.78, 0.55, 0.88, 0.46, 0.72, 0.65]):
        bx = 34 + i * 64
        bh = int(val * 130)
        msd.rectangle([bx, 224 - bh, bx + 40, 224], fill=(34, 211, 238) if val < 0.8 else (245, 165, 35))
    _atomic_save_image(ms, TEXTURE_DIR / "monitor_screen.png")

    # 16. Floor inspection station pad texture (512x512)
    pp = Image.new("RGB", (512, 512), (48, 66, 82))
    ppd = ImageDraw.Draw(pp)
    ppd.rectangle([16, 16, 496, 496], outline=(238, 186, 24), width=18)
    ppd.ellipse([96, 96, 416, 416], fill=(14, 48, 64), outline=(34, 211, 238), width=14)
    ppd.text((178, 202), "巡检点", font=_font(52, True), fill=(125, 240, 255))
    ppd.text((172, 272), "INSPECT", font=_font(38, True), fill=(242, 200, 48))
    _atomic_save_image(pp, TEXTURE_DIR / "patrol_pad.png")

    _atomic_write_text(stamp_file, TEXTURE_VERSION)
    return {n: str(TEXTURE_DIR / n) for n in names}


def _clean_path(path: str) -> str:
    parts = [re.sub(r"[^A-Za-z0-9_]", "_", seg) for seg in path.split("/") if seg]
    return "/" + "/".join(parts)


class SceneBuilder:
    """Clean helper to build UV-mapped PBR textured USD meshes & industrial equipment."""

    def __init__(self, stage):
        self.stage = stage
        self.textures = ensure_textures()
        self.materials = {}
        UsdGeom.Xform.Define(stage, "/World/Environment")
        UsdGeom.Xform.Define(stage, "/World/Traversable")
        UsdGeom.Xform.Define(stage, "/World/Decor")
        UsdGeom.Xform.Define(stage, "/World/Looks")

    def pbr_material(
        self,
        name: str,
        texture_key: str | None = None,
        color=(0.5, 0.5, 0.5),
        roughness: float = 0.55,
        metallic: float = 0.0,
        emissive=(0.0, 0.0, 0.0),
        roughness_tex_key: str | None = None,
    ):
        safe_name = re.sub(r"[^A-Za-z0-9_]", "_", name)
        if safe_name in self.materials:
            return self.materials[safe_name]
        mat_path = f"/World/Looks/{safe_name}"
        mat = UsdShade.Material.Define(self.stage, mat_path)
        shader = UsdShade.Shader.Define(self.stage, f"{mat_path}/Shader")
        shader.CreateIdAttr("UsdPreviewSurface")
        shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(float(metallic))
        if any(c > 0.0 for c in emissive):
            shader.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*emissive))

        st_reader = None
        if texture_key or roughness_tex_key:
            st_reader = UsdShade.Shader.Define(self.stage, f"{mat_path}/stReader")
            st_reader.CreateIdAttr("UsdPrimvarReader_float2")
            st_reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")

        if texture_key:
            tex = UsdShade.Shader.Define(self.stage, f"{mat_path}/DiffuseTex")
            tex.CreateIdAttr("UsdUVTexture")
            tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(self.textures[texture_key])
            tex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
            tex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")
            tex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("sRGB")
            tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(st_reader.ConnectableAPI(), "result")
            shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), "rgb")
        else:
            shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))

        if roughness_tex_key:
            rtex = UsdShade.Shader.Define(self.stage, f"{mat_path}/RoughTex")
            rtex.CreateIdAttr("UsdUVTexture")
            rtex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(self.textures[roughness_tex_key])
            rtex.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
            rtex.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")
            rtex.CreateInput("sourceColorSpace", Sdf.ValueTypeNames.Token).Set("raw")
            rtex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(st_reader.ConnectableAPI(), "result")
            shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).ConnectToSource(rtex.ConnectableAPI(), "r")
        else:
            shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(float(roughness))

        mat.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
        self.materials[safe_name] = mat
        return mat

    def textured_box(
        self,
        path: str,
        pos,
        size,
        mat,
        uv_scale=(1.0, 1.0),
        collision: bool = True,
    ):
        """Create a real UV-mapped 6-face UsdGeom.Mesh box (world-space) with optional PhysX collision."""
        path = _clean_path(path)
        cx, cy, cz = pos
        sx, sy, sz = size
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        pts = [
            Gf.Vec3f(cx - hx, cy - hy, cz - hz),  # 0
            Gf.Vec3f(cx + hx, cy - hy, cz - hz),  # 1
            Gf.Vec3f(cx + hx, cy + hy, cz - hz),  # 2
            Gf.Vec3f(cx - hx, cy + hy, cz - hz),  # 3
            Gf.Vec3f(cx - hx, cy - hy, cz + hz),  # 4
            Gf.Vec3f(cx + hx, cy - hy, cz + hz),  # 5
            Gf.Vec3f(cx + hx, cy + hy, cz + hz),  # 6
            Gf.Vec3f(cx - hx, cy + hy, cz + hz),  # 7
        ]
        # 6 quads with outward winding: -Y, +Y, -X, +X, +Z, -Z
        faces = [
            (0, 1, 5, 4, sx, sz),
            (2, 3, 7, 6, sx, sz),
            (3, 0, 4, 7, sy, sz),
            (1, 2, 6, 5, sy, sz),
            (4, 5, 6, 7, sx, sy),
            (3, 2, 1, 0, sx, sy),
        ]
        indices = []
        uvs = []
        us, vs = uv_scale
        for a, b, c, d, fw, fh in faces:
            indices.extend([a, b, c, d])
            u_max = fw * us
            v_max = fh * vs
            uvs.extend([Gf.Vec2f(0, 0), Gf.Vec2f(u_max, 0), Gf.Vec2f(u_max, v_max), Gf.Vec2f(0, v_max)])

        mesh = UsdGeom.Mesh.Define(self.stage, path)
        mesh.CreatePointsAttr(Vt.Vec3fArray(pts))
        mesh.CreateFaceVertexCountsAttr(Vt.IntArray([4] * 6))
        mesh.CreateFaceVertexIndicesAttr(Vt.IntArray(indices))
        pv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying)
        pv.Set(Vt.Vec2fArray(uvs))
        UsdShade.MaterialBindingAPI(mesh.GetPrim()).Bind(mat)
        if collision:
            UsdPhysics.CollisionAPI.Apply(mesh.GetPrim())
        return mesh

    def textured_quad(self, path: str, corners, mat, uv_max=(1.0, 1.0), double_sided=True):
        """Create a UV-mapped quad (for floor epoxy, painted lanes, cabinet faces, wall signs)."""
        mesh = UsdGeom.Mesh.Define(self.stage, _clean_path(path))
        mesh.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*p) for p in corners]))
        mesh.CreateFaceVertexCountsAttr(Vt.IntArray([4]))
        mesh.CreateFaceVertexIndicesAttr(Vt.IntArray([0, 1, 2, 3]))
        if double_sided:
            mesh.CreateDoubleSidedAttr(True)
        u, v = uv_max
        pv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying)
        pv.Set(Vt.Vec2fArray([Gf.Vec2f(0, 0), Gf.Vec2f(u, 0), Gf.Vec2f(u, v), Gf.Vec2f(0, v)]))
        UsdShade.MaterialBindingAPI(mesh.GetPrim()).Bind(mat)
        return mesh

    def solid_box(self, path: str, pos, size, color, roughness=0.55, metallic=0.1, emissive=(0.0, 0.0, 0.0), collision=True, rotation=None):
        cfg = sim_utils.CuboidCfg(
            size=size,
            collision_props=sim_utils.CollisionPropertiesCfg() if collision else None,
            visual_material=sim_utils.PreviewSurfaceCfg(
                diffuse_color=tuple(float(c) for c in color),
                roughness=float(roughness),
                metallic=float(metallic),
                emissive_color=tuple(float(c) for c in emissive),
            ),
            physics_material=sim_utils.RigidBodyMaterialCfg(static_friction=0.9, dynamic_friction=0.8) if collision else None,
        )
        cfg.func(_clean_path(path), cfg, translation=pos, orientation=rotation or (1.0, 0.0, 0.0, 0.0))

    def solid_cylinder(self, path: str, pos, radius, height, color, roughness=0.45, metallic=0.2, emissive=(0.0, 0.0, 0.0), collision=True, rotation=None):
        cfg = sim_utils.CylinderCfg(
            radius=float(radius),
            height=float(height),
            collision_props=sim_utils.CollisionPropertiesCfg() if collision else None,
            visual_material=sim_utils.PreviewSurfaceCfg(
                diffuse_color=tuple(float(c) for c in color),
                roughness=float(roughness),
                metallic=float(metallic),
                emissive_color=tuple(float(c) for c in emissive),
            ),
        )
        cfg.func(_clean_path(path), cfg, translation=pos, orientation=rotation or (1.0, 0.0, 0.0, 0.0))

    def solid_cone(self, path: str, pos, radius, height, color, roughness=0.5, collision=False):
        cfg = sim_utils.ConeCfg(
            radius=radius,
            height=height,
            collision_props=sim_utils.CollisionPropertiesCfg() if collision else None,
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=color, roughness=roughness),
        )
        cfg.func(_clean_path(path), cfg, translation=pos)

    def add_floor_strip(self, name: str, x0: float, y0: float, x1: float, y1: float, mat, z: float = 0.005):
        self.textured_quad(
            f"/World/Decor/FloorStrip_{name}",
            [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)],
            mat,
            uv_max=(max(1.0, abs(x1 - x0)), max(1.0, abs(y1 - y0))),
        )

    def add_wall_sign(self, name: str, center, width: float, height: float, facing: str, mat):
        cx, cy, cz = center
        hw, hh = width * 0.5, height * 0.5
        if facing == "+Y":
            corners = [(cx + hw, cy, cz - hh), (cx - hw, cy, cz - hh), (cx - hw, cy, cz + hh), (cx + hw, cy, cz + hh)]
        elif facing == "-Y":
            corners = [(cx - hw, cy, cz - hh), (cx + hw, cy, cz - hh), (cx + hw, cy, cz + hh), (cx - hw, cy, cz + hh)]
        elif facing == "+X":
            corners = [(cx, cy - hw, cz - hh), (cx, cy + hw, cz - hh), (cx, cy + hw, cz + hh), (cx, cy - hw, cz + hh)]
        else:  # "-X"
            corners = [(cx, cy + hw, cz - hh), (cx, cy - hw, cz - hh), (cx, cy - hw, cz + hh), (cx, cy + hw, cz + hh)]
        self.textured_quad(f"/World/Decor/Sign_{name}", corners, mat, uv_max=(1.0, 1.0))

    def add_industrial_hall(self, width: float, depth: float, wall_h: float = 3.0, floor_tex="epoxy_floor.png", yellow_top=True):
        """Build photorealistic industrial hall shell: epoxy floor, brick walls, steel I-beams, yellow fascia, high-bay lights."""
        floor_mat = self.pbr_material(
            f"Floor_{floor_tex}",
            texture_key=floor_tex,
            roughness_tex_key="epoxy_roughness.png" if floor_tex == "epoxy_floor.png" else None,
            roughness=0.45,
            metallic=0.05,
        )
        hw, hd = width * 0.5, depth * 0.5
        # Textured industrial floor just above GroundPlane (no collision needed; GroundPlane handles physics!)
        self.textured_quad(
            "/World/Decor/HallFloor",
            [(-hw, -hd, 0.002), (hw, -hd, 0.002), (hw, hd, 0.002), (-hw, hd, 0.002)],
            floor_mat,
            uv_max=(width / 2.5, depth / 2.5),
        )

        brick_mat = self.pbr_material("BrickWall", texture_key="brick_wall.png", roughness=0.82)
        yellow_mat = self.pbr_material("YellowClad", texture_key="yellow_cladding.png", roughness=0.45, metallic=0.15)
        lower_h = min(2.2, wall_h)
        upper_h = max(0.0, wall_h - lower_h)

        # 4 outer brick walls (physical + LiDAR)
        self.textured_box("/World/Environment/WallNorth", (0.0, hd, lower_h / 2), (width + 0.2, 0.22, lower_h), brick_mat, uv_scale=(0.35, 1.0 / lower_h))
        self.textured_box("/World/Environment/WallSouth", (0.0, -hd, lower_h / 2), (width + 0.2, 0.22, lower_h), brick_mat, uv_scale=(0.35, 1.0 / lower_h))
        self.textured_box("/World/Environment/WallEast", (hw, 0.0, lower_h / 2), (0.22, depth, lower_h), brick_mat, uv_scale=(0.35, 1.0 / lower_h))
        self.textured_box("/World/Environment/WallWest", (-hw, 0.0, lower_h / 2), (0.22, depth, lower_h), brick_mat, uv_scale=(0.35, 1.0 / lower_h))

        # Safety-yellow upper wall cladding (decor above 2.2m)
        if yellow_top and upper_h > 0.1:
            zc = lower_h + upper_h / 2
            self.textured_box("/World/Decor/WallNorthTop", (0.0, hd, zc), (width + 0.2, 0.24, upper_h), yellow_mat, uv_scale=(0.45, 0.9), collision=False)
            self.textured_box("/World/Decor/WallSouthTop", (0.0, -hd, zc), (width + 0.2, 0.24, upper_h), yellow_mat, uv_scale=(0.45, 0.9), collision=False)
            self.textured_box("/World/Decor/WallEastTop", (hw, 0.0, zc), (0.24, depth, upper_h), yellow_mat, uv_scale=(0.45, 0.9), collision=False)
            self.textured_box("/World/Decor/WallWestTop", (-hw, 0.0, zc), (0.24, depth, upper_h), yellow_mat, uv_scale=(0.45, 0.9), collision=False)

        # Structural steel I-beam columns along walls (authentic factory look!)
        beam_col = (0.36, 0.40, 0.44)
        col_xs = [x for x in range(-int(hw) + 1, int(hw), 3)]
        for i, x in enumerate(col_xs):
            self.solid_box(f"/World/Decor/ColN_{i}", (float(x), hd - 0.16, wall_h / 2), (0.18, 0.18, wall_h), beam_col, roughness=0.45, metallic=0.55, collision=False)
            self.solid_box(f"/World/Decor/ColS_{i}", (float(x), -hd + 0.16, wall_h / 2), (0.18, 0.18, wall_h), beam_col, roughness=0.45, metallic=0.55, collision=False)
        col_ys = [y for y in range(-int(hd) + 2, int(hd), 3)]
        for i, y in enumerate(col_ys):
            self.solid_box(f"/World/Decor/ColE_{i}", (hw - 0.16, float(y), wall_h / 2), (0.18, 0.18, wall_h), beam_col, roughness=0.45, metallic=0.55, collision=False)
            self.solid_box(f"/World/Decor/ColW_{i}", (-hw + 0.16, float(y), wall_h / 2), (0.18, 0.18, wall_h), beam_col, roughness=0.45, metallic=0.55, collision=False)

        # Overhead steel roof trusses + glowing industrial LED high-bay fixtures
        truss_z = wall_h - 0.12
        for i, x in enumerate(col_xs):
            self.solid_box(f"/World/Decor/Truss_{i}", (float(x), 0.0, truss_z), (0.12, depth - 0.3, 0.14), (0.30, 0.34, 0.38), roughness=0.5, metallic=0.6, collision=False)
            for j, ly in enumerate((-hd * 0.45, hd * 0.45)):
                # Light housing + glowing LED panel
                self.solid_box(f"/World/Decor/LampBody_{i}_{j}", (float(x), ly, truss_z - 0.10), (0.95, 0.24, 0.06), (0.20, 0.22, 0.25), roughness=0.4, metallic=0.6, collision=False)
                self.solid_box(f"/World/Decor/LampGlow_{i}_{j}", (float(x), ly, truss_z - 0.14), (0.86, 0.18, 0.02), (1.0, 0.99, 0.96), roughness=0.2, emissive=(2.2, 2.2, 2.1), collision=False)

        # Real overhead industrial area lights (soft reflections on epoxy floor!)
        for idx, (lx, ly) in enumerate([(-hw * 0.45, -hd * 0.35), (-hw * 0.45, hd * 0.35), (hw * 0.45, -hd * 0.35), (hw * 0.45, hd * 0.35)]):
            lprim = UsdLux.RectLight.Define(self.stage, f"/World/Decor/HighBayLight_{idx}")
            lprim.CreateWidthAttr(2.4)
            lprim.CreateHeightAttr(1.2)
            lprim.CreateIntensityAttr(1100.0)
            lprim.CreateColorAttr(Gf.Vec3f(0.96, 0.97, 1.0))
            UsdGeom.XformCommonAPI(lprim).SetTranslate(Gf.Vec3d(lx, ly, wall_h - 0.22))

    def add_switchgear_cabinet(self, name: str, pos, size=(0.76, 0.62, 1.85), texture_key="switchgear_hv.png", face_dir="-Y", status="green"):
        """Multi-part industrial electrical cabinet with UV-mapped dial gauges, top busbar hood & glowing status beacon."""
        x, y, _ = pos
        sx, sy, sz = size
        # Main steel cabinet body (collision + LiDAR)
        self.solid_box(f"/World/Environment/{name}", (x, y, sz * 0.5), (sx, sy, sz), (0.22, 0.26, 0.31), roughness=0.45, metallic=0.55, collision=True)
        # Dark recessed base plinth
        self.solid_box(f"/World/Decor/{name}_Base", (x, y, 0.05), (sx + 0.04, sy + 0.04, 0.10), (0.10, 0.12, 0.14), roughness=0.7, metallic=0.3, collision=False)
        # Top busbar hood
        self.solid_box(f"/World/Decor/{name}_Hood", (x, y, sz + 0.09), (sx - 0.04, sy - 0.04, 0.18), (0.18, 0.22, 0.27), roughness=0.4, metallic=0.6, collision=False)
        # Glowing industrial status beacon tower on top!
        b_col = (0.12, 0.95, 0.42) if status == "green" else (1.0, 0.72, 0.10) if status == "amber" else (1.0, 0.22, 0.18)
        self.solid_cylinder(f"/World/Decor/{name}_Stem", (x + sx * 0.28, y, sz + 0.24), 0.022, 0.14, (0.25, 0.28, 0.32), metallic=0.7, collision=False)
        self.solid_cylinder(f"/World/Decor/{name}_Beacon", (x + sx * 0.28, y, sz + 0.35), 0.045, 0.10, b_col, roughness=0.2, emissive=tuple(c * 2.4 for c in b_col), collision=False)

        # Front UV-mapped control panel with dial gauges & LCD!
        mat = self.pbr_material(f"Mat_{texture_key}", texture_key=texture_key, roughness=0.38, metallic=0.22)
        eps = 0.008
        if face_dir == "-Y":
            corners = [(x - sx / 2 + 0.02, y - sy / 2 - eps, 0.10), (x + sx / 2 - 0.02, y - sy / 2 - eps, 0.10),
                       (x + sx / 2 - 0.02, y - sy / 2 - eps, sz - 0.03), (x - sx / 2 + 0.02, y - sy / 2 - eps, sz - 0.03)]
        elif face_dir == "+Y":
            corners = [(x + sx / 2 - 0.02, y + sy / 2 + eps, 0.10), (x - sx / 2 + 0.02, y + sy / 2 + eps, 0.10),
                       (x - sx / 2 + 0.02, y + sy / 2 + eps, sz - 0.03), (x + sx / 2 - 0.02, y + sy / 2 + eps, sz - 0.03)]
        elif face_dir == "-X":
            corners = [(x - sx / 2 - eps, y + sy / 2 - 0.02, 0.10), (x - sx / 2 - eps, y - sy / 2 + 0.02, 0.10),
                       (x - sx / 2 - eps, y - sy / 2 + 0.02, sz - 0.03), (x - sx / 2 - eps, y + sy / 2 - 0.02, sz - 0.03)]
        else:  # "+X"
            corners = [(x + sx / 2 + eps, y - sy / 2 + 0.02, 0.10), (x + sx / 2 + eps, y + sy / 2 - 0.02, 0.10),
                       (x + sx / 2 + eps, y + sy / 2 - 0.02, sz - 0.03), (x + sx / 2 + eps, y - sy / 2 + 0.02, sz - 0.03)]
        self.textured_quad(f"/World/Decor/{name}_Panel", corners, mat, uv_max=(1.0, 1.0))

    def add_pipe_valve_station(self, name: str, wall_x: float, y_center: float, length: float = 2.6):
        """Color-coded industrial pipeline manifold along an east wall (+X) with red valve handwheels & pressure gauges."""
        # Rotate cylinder from Z-axis to Y-axis: quat_x(90 deg) = (cos45, sin45, 0, 0)
        q_along_y = (0.7071, 0.7071, 0.0, 0.0)
        q_along_x = (0.7071, 0.0, 0.7071, 0.0)
        pipes = [
            ("FireRed", 1.20, 0.055, (0.82, 0.12, 0.12)),
            ("CoolBlue", 0.88, 0.050, (0.12, 0.42, 0.78)),
            ("AirYellow", 0.58, 0.045, (0.88, 0.68, 0.08)),
        ]
        px = wall_x - 0.24
        # Thin dark steel mounting backboard flush against the wall (never obscures pipes or gauges!)
        self.solid_box(f"/World/Environment/{name}_Backplate", (wall_x - 0.13, y_center, 0.90), (0.04, length + 0.10, 1.35), (0.16, 0.19, 0.23), roughness=0.55, metallic=0.65, collision=True)
        for pname, pz, pr, pcol in pipes:
            self.solid_cylinder(f"/World/Environment/{name}_Pipe_{pname}", (px, y_center, pz), pr, length, pcol, roughness=0.28, metallic=0.68, collision=True, rotation=q_along_y)
            # Flanges & mounting brackets
            for bi, dy in enumerate((-length * 0.36, 0.0, length * 0.36)):
                self.solid_cylinder(f"/World/Decor/{name}_Flange_{pname}_{bi}", (px, y_center + dy, pz), pr * 1.45, 0.04, (0.22, 0.25, 0.28), roughness=0.4, metallic=0.7, collision=False, rotation=q_along_y)
                self.solid_box(f"/World/Decor/{name}_Brk_{pname}_{bi}", (px + 0.06, y_center + dy, pz), (0.12, 0.05, 0.05), (0.28, 0.30, 0.34), metallic=0.6, collision=False)
        # 2 Red Valve Handwheels + Pressure Gauge Risers facing into the room (-X)
        gauge_mat = self.pbr_material("GaugeDial", texture_key="gauge_dial.png", roughness=0.25)
        for vi, (vy, vz) in enumerate(((y_center - 0.65, 1.20), (y_center + 0.55, 0.88))):
            # Valve stem & wheel
            self.solid_cylinder(f"/World/Decor/{name}_Stem_{vi}", (px - 0.10, vy, vz), 0.025, 0.16, (0.22, 0.24, 0.28), metallic=0.75, collision=False, rotation=q_along_x)
            self.solid_cylinder(f"/World/Decor/{name}_Wheel_{vi}", (px - 0.19, vy, vz), 0.13, 0.028, (0.88, 0.14, 0.14), roughness=0.35, metallic=0.45, collision=False, rotation=q_along_x)
            # Pressure gauge stem + dial quad facing -X
            gz = vz + 0.22
            self.solid_cylinder(f"/World/Decor/{name}_GStem_{vi}", (px, vy + 0.26, vz + 0.10), 0.014, 0.18, (0.72, 0.62, 0.24), metallic=0.8, collision=False)
            self.solid_cylinder(f"/World/Decor/{name}_GCase_{vi}", (px, vy + 0.26, gz), 0.09, 0.05, (0.22, 0.25, 0.30), metallic=0.7, collision=False, rotation=q_along_x)
            self.add_wall_sign(f"{name}_GDial_{vi}", (px - 0.032, vy + 0.26, gz), 0.16, 0.16, "-X", gauge_mat)

    def add_fire_extinguisher(self, name: str, x: float, y: float):
        self.solid_cylinder(f"/World/Environment/{name}_Body", (x, y, 0.28), 0.085, 0.54, (0.82, 0.10, 0.10), roughness=0.28, metallic=0.45, collision=True)
        self.solid_cylinder(f"/World/Decor/{name}_Neck", (x, y, 0.59), 0.032, 0.08, (0.14, 0.16, 0.18), metallic=0.75, collision=False)
        self.solid_box(f"/World/Decor/{name}_Handle", (x + 0.05, y, 0.64), (0.12, 0.025, 0.03), (0.12, 0.14, 0.16), metallic=0.6, collision=False)

    def add_traffic_cone(self, name: str, x: float, y: float):
        self.solid_box(f"/World/Decor/{name}_Base", (x, y, 0.02), (0.30, 0.30, 0.04), (0.12, 0.13, 0.15), roughness=0.8, collision=False)
        self.solid_cone(f"/World/Decor/{name}_Cone", (x, y, 0.27), 0.12, 0.48, (0.96, 0.36, 0.04), roughness=0.42, collision=False)
        self.solid_cylinder(f"/World/Decor/{name}_Stripe", (x, y, 0.30), 0.078, 0.08, (0.96, 0.97, 0.98), roughness=0.25, emissive=(0.15, 0.15, 0.15), collision=False)

    def add_safety_bollard(self, name: str, x: float, y: float, height: float = 0.78):
        self.solid_cylinder(f"/World/Environment/{name}", (x, y, height * 0.5), 0.085, height, (0.92, 0.68, 0.06), roughness=0.35, metallic=0.35, collision=True)
        self.solid_cylinder(f"/World/Decor/{name}_Band1", (x, y, height * 0.78), 0.089, 0.09, (0.10, 0.11, 0.13), roughness=0.5, collision=False)
        self.solid_cylinder(f"/World/Decor/{name}_Band2", (x, y, height * 0.52), 0.089, 0.09, (0.10, 0.11, 0.13), roughness=0.5, collision=False)

    def add_patrol_pad(self, index: int, x: float, y: float):
        pad_mat = self.pbr_material("PatrolPad", texture_key="patrol_pad.png", roughness=0.35, emissive=(0.06, 0.14, 0.18))
        r = 0.34
        self.textured_quad(
            f"/World/Decor/PatrolPad_{index}",
            [(x - r, y - r, 0.008), (x + r, y - r, 0.008), (x + r, y + r, 0.008), (x - r, y + r, 0.008)],
            pad_mat,
        )

    def add_transformer_unit(self, name: str, x: float, y: float):
        """High-voltage industrial dry-type/oil transformer with cooling fins & ceramic porcelain bushings."""
        # Concrete pad
        slab_mat = self.pbr_material("ConcreteSlab", texture_key="concrete_slab.png", roughness=0.85)
        self.textured_box(f"/World/Decor/{name}_Pad", (x, y, 0.06), (1.95, 1.45, 0.12), slab_mat, uv_scale=(0.8, 0.8), collision=False)
        # Main tank
        self.solid_box(f"/World/Environment/{name}_Tank", (x, y, 0.72), (1.40, 0.92, 1.24), (0.34, 0.40, 0.46), roughness=0.48, metallic=0.55, collision=True)
        # Radiator cooling fins along sides
        for i in range(6):
            fx = x - 0.50 + i * 0.20
            self.solid_box(f"/World/Decor/{name}_FinF_{i}", (fx, y - 0.52, 0.72), (0.04, 0.16, 1.02), (0.28, 0.33, 0.38), metallic=0.65, collision=False)
            self.solid_box(f"/World/Decor/{name}_FinB_{i}", (fx, y + 0.52, 0.72), (0.04, 0.16, 1.02), (0.28, 0.33, 0.38), metallic=0.65, collision=False)
        # 3 Porcelain HV bushings on top
        for i, bx in enumerate((x - 0.36, x, x + 0.36)):
            self.solid_cylinder(f"/World/Decor/{name}_Bush_{i}", (bx, y, 1.56), 0.065, 0.44, (0.48, 0.24, 0.16), roughness=0.25, metallic=0.1, collision=False)
            for ring_i, rz in enumerate((1.44, 1.54, 1.64)):
                self.solid_cylinder(f"/World/Decor/{name}_Ring_{i}_{ring_i}", (bx, y, rz), 0.10, 0.03, (0.56, 0.30, 0.20), roughness=0.22, collision=False)
        # Conservator tank on top
        self.solid_cylinder(f"/World/Decor/{name}_Cons", (x, y + 0.26, 1.54), 0.14, 0.95, (0.38, 0.44, 0.50), metallic=0.55, collision=False, rotation=(0.7071, 0.0, 0.7071, 0.0))

    def add_forklift(self, name: str, x: float, y: float):
        """Detailed multi-part 3D industrial yellow forklift."""
        # Counterweight chassis (collision + LiDAR)
        self.solid_box(f"/World/Environment/{name}_Body", (x, y, 0.52), (1.75, 1.08, 0.72), (0.94, 0.70, 0.06), roughness=0.35, metallic=0.30, collision=True)
        self.solid_box(f"/World/Decor/{name}_Rear", (x - 0.72, y, 0.62), (0.42, 1.06, 0.68), (0.16, 0.18, 0.21), roughness=0.5, metallic=0.4, collision=False)
        # Driver seat & overhead safety roll cage
        self.solid_box(f"/World/Decor/{name}_Seat", (x - 0.18, y, 1.05), (0.46, 0.48, 0.36), (0.12, 0.13, 0.15), roughness=0.8, collision=False)
        for pi, (dx, dy) in enumerate(((-0.62, -0.46), (-0.62, 0.46), (0.48, -0.46), (0.48, 0.46))):
            self.solid_box(f"/World/Decor/{name}_Post_{pi}", (x + dx, y + dy, 1.48), (0.06, 0.06, 1.24), (0.14, 0.15, 0.18), metallic=0.6, collision=False)
        self.solid_box(f"/World/Decor/{name}_Roof", (x - 0.07, y, 2.08), (1.22, 1.00, 0.07), (0.14, 0.15, 0.18), metallic=0.6, collision=False)
        # Amber roof beacon
        self.solid_cylinder(f"/World/Decor/{name}_Beacon", (x - 0.45, y, 2.18), 0.055, 0.11, (1.0, 0.65, 0.05), emissive=(2.4, 1.5, 0.1), collision=False)
        # Dual vertical mast rails + steel forks
        for mi, dy in enumerate((-0.34, 0.34)):
            self.solid_box(f"/World/Environment/{name}_Mast_{mi}", (x + 0.96, y + dy, 1.18), (0.11, 0.10, 2.20), (0.15, 0.16, 0.19), metallic=0.65, collision=True)
            self.solid_box(f"/World/Decor/{name}_Fork_{mi}", (x + 1.45, y + dy, 0.10), (0.98, 0.11, 0.05), (0.28, 0.30, 0.34), metallic=0.75, collision=False)
        # 4 Rubber wheels
        q_wheel = (0.7071, 0.7071, 0.0, 0.0)
        for wi, (dx, dy, rad) in enumerate(((-0.56, -0.56, 0.24), (-0.56, 0.56, 0.24), (0.58, -0.56, 0.30), (0.58, 0.56, 0.30))):
            self.solid_cylinder(f"/World/Decor/{name}_Tire_{wi}", (x + dx, y + dy, rad), rad, 0.18, (0.10, 0.11, 0.12), roughness=0.9, collision=False, rotation=q_wheel)
            self.solid_cylinder(f"/World/Decor/{name}_Hub_{wi}", (x + dx, y + dy, rad), rad * 0.48, 0.20, (0.82, 0.68, 0.12), metallic=0.5, collision=False, rotation=q_wheel)


def build_realistic_indoor(stage):
    """智能配电房与机房工业巡检中心（12m x 10m，保留流畅通行通道与真实巡检设备）"""
    b = SceneBuilder(stage)
    b.add_industrial_hall(12.0, 10.0, wall_h=3.0, floor_tex="epoxy_floor.png", yellow_top=True)

    brick_mat = b.pbr_material("BrickWall", texture_key="brick_wall.png", roughness=0.82)
    yellow_line = b.pbr_material("YellowLane", color=(0.92, 0.72, 0.08), roughness=0.45)
    hz_mat = b.pbr_material("HazardFloor", texture_key="hazard_stripe.png", roughness=0.5)
    sign_hv = b.pbr_material("SignHV", texture_key="sign_hv.png", roughness=0.35)
    sign_patrol = b.pbr_material("SignPatrol", texture_key="sign_patrol.png", roughness=0.35)
    sign_safety = b.pbr_material("SignSafety", texture_key="sign_safety.png", roughness=0.35)

    # Interior partition walls (2.2m industrial concrete/brick walls with steel doorway framing)
    b.textured_box("/World/Environment/OfficeDividerA", (-1.2, 2.2, 1.1), (0.18, 3.6, 2.2), brick_mat, uv_scale=(0.35, 1.0 / 2.2))
    b.textured_box("/World/Environment/OfficeDividerB", (-1.2, -3.7, 1.1), (0.18, 2.4, 2.2), brick_mat, uv_scale=(0.35, 1.0 / 2.2))
    b.textured_box("/World/Environment/MeetingRoomA", (2.1, 1.1, 1.1), (4.6, 0.18, 2.2), brick_mat, uv_scale=(0.35, 1.0 / 2.2))
    # Steel doorway frame pillars (open doorway y in [-2.5, +0.4] -> 2.9m wide, super comfortable for Nav2!)
    b.solid_box("/World/Decor/DoorFrameTop", (-1.2, -1.05, 2.15), (0.24, 2.92, 0.16), (0.28, 0.32, 0.38), metallic=0.6, collision=False)
    b.solid_box("/World/Decor/DoorPostA", (-1.2, 0.36, 1.1), (0.24, 0.10, 2.2), (0.28, 0.32, 0.38), metallic=0.6, collision=False)
    b.solid_box("/World/Decor/DoorPostB", (-1.2, -2.46, 1.1), (0.24, 0.10, 2.2), (0.28, 0.32, 0.38), metallic=0.6, collision=False)

    # Safety yellow walkway lines along the inspection corridor!
    b.add_floor_strip("Lane_WestL", -3.95, -3.8, -3.85, 1.4, yellow_line)
    b.add_floor_strip("Lane_WestR", -1.95, -3.8, -1.85, 1.4, yellow_line)
    b.add_floor_strip("Lane_CrossT", -3.95, -0.35, 4.4, -0.25, yellow_line)
    b.add_floor_strip("Lane_CrossB", -3.95, -1.55, 4.4, -1.45, yellow_line)
    # Hazard zone mat in front of main HV switchgear bank
    b.add_floor_strip("Hazard_Swg", 0.55, -2.95, 3.65, -2.72, hz_mat)

    # 1) Main HV Switchgear & Thermal Control Cabinet Array (central-south bay: faces BOTH -Y & +Y corridor!)
    b.add_switchgear_cabinet("Switchgear_HV01", (1.15, -2.35, 0.0), (0.80, 0.66, 1.92), "switchgear_hv.png", face_dir="+Y", status="green")
    b.add_switchgear_cabinet("ThermalCabinet_02", (2.05, -2.35, 0.0), (0.80, 0.66, 1.92), "thermal_cabinet.png", face_dir="+Y", status="amber")
    b.add_switchgear_cabinet("Switchgear_HV03", (2.95, -2.35, 0.0), (0.80, 0.66, 1.92), "switchgear_hv.png", face_dir="+Y", status="green")
    # Also place a primary switchgear cabinet on the WEST wall facing into the west room so it's immediately visible from spawn!
    b.add_switchgear_cabinet("WestSwitchgear_01", (-5.45, -1.85, 0.0), (0.68, 0.82, 1.95), "switchgear_hv.png", face_dir="+X", status="green")
    b.add_switchgear_cabinet("WestThermal_02", (-5.45, -0.85, 0.0), (0.68, 0.82, 1.95), "thermal_cabinet.png", face_dir="+X", status="amber")
    b.add_switchgear_cabinet("WestServer_03", (-5.45, 0.15, 0.0), (0.68, 0.82, 1.95), "server_rack.png", face_dir="+X", status="green")

    # 2) North-East Server Room: 4x 42U Server Racks with overhead cable tray
    for i, sx in enumerate((0.8, 1.75, 2.70, 3.65)):
        b.add_switchgear_cabinet(f"ServerRack_E0{i+1}", (sx, 3.95, 0.0), (0.78, 0.74, 2.02), "server_rack.png", face_dir="-Y", status="green")
    b.solid_box("/World/Decor/CableTray", (2.22, 3.95, 2.28), (3.8, 0.40, 0.06), (0.18, 0.22, 0.26), metallic=0.7, collision=False)

    # 3) West Control Console Desk with Dual SCADA Monitors + Industrial Transformer Bay
    b.solid_box("/World/Environment/ControlDeskTop", (-3.8, 3.2, 0.76), (1.8, 0.78, 0.07), (0.28, 0.34, 0.40), roughness=0.45, metallic=0.35, collision=True)
    for leg, (dx, dy) in enumerate(((-0.82, -0.32), (-0.82, 0.32), (0.82, -0.32), (0.82, 0.32))):
        b.solid_box(f"/World/Decor/DeskLeg_{leg}", (-3.8 + dx, 3.2 + dy, 0.38), (0.06, 0.06, 0.76), (0.18, 0.20, 0.24), metallic=0.65, collision=False)
    mon_mat = b.pbr_material("MonitorScreen", texture_key="monitor_screen.png", roughness=0.2, emissive=(0.15, 0.35, 0.45))
    for mi, mx in enumerate((-4.22, -3.42)):
        b.solid_box(f"/World/Decor/MonFrame_{mi}", (mx, 3.32, 1.04), (0.64, 0.05, 0.38), (0.10, 0.12, 0.14), roughness=0.4, collision=False)
        b.solid_box(f"/World/Decor/MonStand_{mi}", (mx, 3.32, 0.82), (0.08, 0.08, 0.12), (0.18, 0.20, 0.24), metallic=0.6, collision=False)
        b.add_wall_sign(f"MonScreen_{mi}", (mx, 3.29, 1.04), 0.58, 0.32, "-Y", mon_mat)

    # 4) South-East Fire Pipeline Manifold, Valves, Pressure Gauges & Fire Hydrant Station
    b.add_pipe_valve_station("EastFireManifold", 5.88, -2.2, length=3.0)
    b.add_switchgear_cabinet("FireHydrantBox", (5.58, 0.25, 0.0), (0.36, 0.72, 1.55), "fire_cabinet.png", face_dir="-X", status="red")
    b.add_fire_extinguisher("FireExt_West", -1.55, -2.75)
    b.add_fire_extinguisher("FireExt_East", 5.35, -0.45)

    # 5) Industrial Wall Safety Placards (super clear in Go2 onboard & overview cameras!)
    b.add_wall_sign("HV_WestDivider", (-1.31, 1.8, 1.55), 1.45, 0.72, "-X", sign_hv)
    b.add_wall_sign("Patrol_NorthWall", (-3.5, 4.86, 1.65), 1.80, 0.86, "-Y", sign_patrol)
    b.add_wall_sign("Safety_SouthWall", (-3.5, -4.86, 1.65), 1.70, 0.82, "+Y", sign_safety)
    b.add_wall_sign("HV_EastDivider", (2.1, 0.99, 1.55), 1.55, 0.76, "-Y", sign_hv)

    # 6) Safety Cones & Bollards near corners (kept well clear of walkable aisles!)
    b.add_traffic_cone("Cone_NW", -4.75, 1.45)
    b.add_traffic_cone("Cone_SE", 4.65, -3.95)
    b.add_safety_bollard("Bollard_SwgL", 0.55, -2.35)
    b.add_safety_bollard("Bollard_SwgR", 3.55, -2.35)

    # 7) Painted Inspection Target Pads on the floor
    for i, (px, py) in enumerate(((-3.4, -1.8), (-2.1, -1.2), (1.8, -0.9), (4.5, -2.2))):
        b.add_patrol_pad(i, px, py)


def build_realistic_warehouse(stage):
    """工业智能仓储物流巡检厂房（16m x 13m：高写实货架、栈板、纸箱、叉车、配电箱与消防设施）"""
    b = SceneBuilder(stage)
    b.add_industrial_hall(16.0, 13.0, wall_h=3.6, floor_tex="epoxy_floor.png", yellow_top=True)

    crate_mat = b.pbr_material("CardboardBox", texture_key="cardboard_box.png", roughness=0.85)
    pallet_mat = b.pbr_material("WoodPallet", texture_key="wood_pallet.png", roughness=0.88)
    yellow_line = b.pbr_material("YellowLane", color=(0.92, 0.72, 0.08), roughness=0.45)
    sign_safety = b.pbr_material("SignSafety", texture_key="sign_safety.png", roughness=0.35)
    sign_patrol = b.pbr_material("SignPatrol", texture_key="sign_patrol.png", roughness=0.35)

    # Forklift aisle floor markings
    b.add_floor_strip("Aisle_MainT", -7.2, -0.1, 7.2, 0.02, yellow_line)
    b.add_floor_strip("Aisle_MainB", -7.2, -1.9, 7.2, -1.78, yellow_line)

    # Heavy-duty blue/orange industrial steel pallet racks with pallets, cardboard boxes & barrels
    rack_blue = (0.10, 0.28, 0.56)
    beam_orange = (0.92, 0.42, 0.06)
    for idx, (rx, ry) in enumerate(((-4.2, 2.4), (0.0, 2.4), (4.2, 2.4))):
        for pi, (dx, dy) in enumerate(((-1.35, -0.45), (-1.35, 0.45), (1.35, -0.45), (1.35, 0.45))):
            b.solid_box(f"/World/Environment/Rack_{idx}_Post_{pi}", (rx + dx, ry + dy, 1.35), (0.09, 0.09, 2.70), rack_blue, roughness=0.4, metallic=0.55, collision=True)
        for li, lz in enumerate((0.12, 1.05, 1.98)):
            b.solid_box(f"/World/Environment/Rack_{idx}_Beam_{li}", (rx, ry, lz), (2.82, 0.96, 0.09), beam_orange, roughness=0.42, metallic=0.45, collision=True)
            if li < 2:
                for ci, dx in enumerate((-0.86, 0.0, 0.86)):
                    b.textured_box(f"/World/Decor/Rack_{idx}_Pal_{li}_{ci}", (rx + dx, ry, lz + 0.09), (0.76, 0.82, 0.09), pallet_mat, uv_scale=(1.0, 1.0), collision=False)
                    b.textured_box(f"/World/Environment/Rack_{idx}_Box_{li}_{ci}", (rx + dx, ry, lz + 0.44), (0.64, 0.66, 0.60), crate_mat, uv_scale=(1.0, 1.0), collision=True)

    # Parked 3D Yellow Forklift in the loading bay!
    b.add_forklift("Forklift_01", 4.2, -3.4)

    # Floor pallets + cargo stack + industrial chemical drums
    for i, (cx, cy, cz, sz) in enumerate(((-4.8, -3.0, 0.42, 0.78), (-3.9, -3.0, 0.42, 0.78), (-4.35, -3.0, 1.18, 0.72), (-1.8, -3.6, 0.40, 0.74))):
        b.textured_box(f"/World/Environment/FloorBox_{i}", (cx, cy, cz), (sz, sz, sz), crate_mat, uv_scale=(1.0, 1.0), collision=True)
    for bi, (bx, by, col) in enumerate(((-0.5, -3.8, (0.08, 0.36, 0.78)), (0.25, -3.8, (0.08, 0.36, 0.78)), (0.95, -3.8, (0.76, 0.16, 0.12)))):
        b.solid_cylinder(f"/World/Environment/Drum_{bi}", (bx, by, 0.46), 0.28, 0.92, col, roughness=0.35, metallic=0.25, collision=True)

    # Warehouse electrical panel, fire station, bollards & cones
    b.add_switchgear_cabinet("WarehousePanel", (-7.45, -1.0, 0.0), (0.62, 0.82, 1.90), "switchgear_hv.png", face_dir="+X", status="green")
    b.add_switchgear_cabinet("WarehouseFireBox", (7.58, 0.4, 0.0), (0.36, 0.72, 1.55), "fire_cabinet.png", face_dir="-X", status="red")
    b.add_fire_extinguisher("WhFireExt", -6.9, -2.0)
    for i, (bx, by) in enumerate(((-2.8, -5.2), (-1.4, -5.2), (0.0, -5.2), (1.4, -5.2))):
        b.add_safety_bollard(f"WhBollard_{i}", bx, by)
    b.add_traffic_cone("WhCone_1", 2.4, -2.6)
    b.add_traffic_cone("WhCone_2", -2.8, 0.6)
    b.add_wall_sign("WhSign1", (0.0, 6.35, 2.0), 2.4, 1.1, "-Y", sign_patrol)
    b.add_wall_sign("WhSign2", (-7.85, 2.0, 1.8), 2.0, 0.95, "+X", sign_safety)

    for i, (px, py) in enumerate(((-5.2, -0.9), (-1.8, -0.9), (2.2, -0.9), (5.5, 4.2))):
        b.add_patrol_pad(i, px, py)


def build_realistic_outdoor(stage):
    """户外变电站与工业园区巡检场（17m x 14m：沥青路面、高压主变台区、防滑坡道与台阶、护栏与警示墩）"""
    b = SceneBuilder(stage)
    asph_mat = b.pbr_material("AsphaltRoad", texture_key="asphalt_road.png", roughness=0.88)
    slab_mat = b.pbr_material("ConcreteSlab", texture_key="concrete_slab.png", roughness=0.82)
    hz_mat = b.pbr_material("HazardStripe", texture_key="hazard_stripe.png", roughness=0.55)
    yellow_line = b.pbr_material("YellowLane", color=(0.94, 0.76, 0.10), roughness=0.5)
    sign_hv = b.pbr_material("SignHV", texture_key="sign_hv.png", roughness=0.35)

    # Textured outdoor asphalt ground (17m x 14m)
    b.textured_quad("/World/Decor/OutdoorAsphalt", [(-8.5, -7.0, 0.002), (8.5, -7.0, 0.002), (8.5, 7.0, 0.002), (-8.5, 7.0, 0.002)], asph_mat, uv_max=(6.0, 5.0))
    # Road safety lane stripes
    b.add_floor_strip("RoadLineN", -7.8, -0.1, 7.8, 0.05, yellow_line)
    b.add_floor_strip("RoadLineS", -7.8, -4.4, 7.8, -4.25, yellow_line)

    # Perimeter low concrete curb + industrial steel security fence posts & horizontal rails
    for name, pos, sz in [
        ("CurbN", (0.0, 7.0, 0.25), (17.2, 0.28, 0.50)),
        ("CurbS", (0.0, -7.0, 0.25), (17.2, 0.28, 0.50)),
        ("CurbE", (8.5, 0.0, 0.25), (0.28, 14.0, 0.50)),
        ("CurbW", (-8.5, 0.0, 0.25), (0.28, 14.0, 0.50)),
    ]:
        b.textured_box(f"/World/Environment/{name}", pos, sz, slab_mat, uv_scale=(0.5, 1.0))
    for i, x in enumerate(range(-8, 9, 2)):
        b.solid_box(f"/World/Environment/FencePostN_{i}", (float(x), 7.0, 1.05), (0.08, 0.08, 1.6), (0.24, 0.28, 0.32), metallic=0.6)
        b.solid_box(f"/World/Environment/FencePostS_{i}", (float(x), -7.0, 1.05), (0.08, 0.08, 1.6), (0.24, 0.28, 0.32), metallic=0.6)
    for rz in (0.95, 1.55):
        b.solid_box(f"/World/Decor/FenceRailN_{rz}", (0.0, 7.0, rz), (17.0, 0.05, 0.05), (0.28, 0.32, 0.36), metallic=0.6, collision=False)
        b.solid_box(f"/World/Decor/FenceRailS_{rz}", (0.0, -7.0, rz), (17.0, 0.05, 0.05), (0.28, 0.32, 0.36), metallic=0.6, collision=False)

    # Outdoor HV Power Substation Transformer Bay!
    b.add_transformer_unit("SubstationTransformer_A", 4.6, -2.4)
    b.add_switchgear_cabinet("OutdoorWeatherCabinet", (6.8, -2.4, 0.0), (0.76, 0.84, 1.85), "switchgear_hv.png", face_dir="-X", status="green")
    b.add_wall_sign("OutdoorHVSign", (4.6, -1.55, 1.35), 1.15, 0.56, "+Y", sign_hv)
    for i, bx in enumerate((3.5, 4.6, 5.7)):
        b.add_safety_bollard(f"SubBollard_{i}", bx, -1.25)

    # Textured Industrial Concrete Inspection Ramp + Platform + Yellow Safety Handrails
    q_up = (math.cos(math.radians(-11.0) / 2), 0.0, math.sin(math.radians(-11.0) / 2), 0.0)
    q_dn = (math.cos(math.radians(11.0) / 2), 0.0, math.sin(math.radians(11.0) / 2), 0.0)
    b.solid_box("/World/Traversable/RampUp", (-2.8, 2.2, 0.34), (3.6, 2.2, 0.16), (0.52, 0.55, 0.58), roughness=0.82, collision=True, rotation=q_up)
    b.textured_box("/World/Traversable/RampPlatform", (0.1, 2.2, 0.68), (2.2, 2.2, 0.18), slab_mat, uv_scale=(1.0, 1.0))
    b.solid_box("/World/Traversable/RampDown", (2.7, 2.2, 0.34), (3.6, 2.2, 0.16), (0.52, 0.55, 0.58), roughness=0.82, collision=True, rotation=q_dn)
    # Yellow tubular safety guardrails on the elevated platform
    for dy in (-1.05, 1.05):
        b.solid_box(f"/World/Decor/RampRail_{dy}", (0.1, 2.2 + dy, 1.38), (2.2, 0.05, 0.05), (0.94, 0.72, 0.08), metallic=0.4, collision=False)
        for dx in (-0.95, 0.95):
            b.solid_box(f"/World/Decor/RampPost_{dx}_{dy}", (0.1 + dx, 2.2 + dy, 1.08), (0.05, 0.05, 0.65), (0.94, 0.72, 0.08), metallic=0.4, collision=False)

    # Industrial concrete steps
    for index in range(6):
        h = 0.095 * (index + 1)
        b.textured_box(f"/World/Environment/Stair_{index}", (-5.0 + index * 0.44, -2.0, h / 2), (0.45, 1.85, h), slab_mat, uv_scale=(1.0, 1.0))

    # Yellow-black striped concrete jersey safety barriers along north yard
    for i, x in enumerate((-6.0, -3.0, 0.0, 3.0, 6.0)):
        b.textured_box(f"/World/Environment/SafetyBarrier_{i}", (x, 5.2, 0.30), (1.35, 0.42, 0.60), hz_mat, uv_scale=(0.8, 1.2))
    # Outdoor utility floodlight poles
    for i, (px, py) in enumerate(((-7.4, 5.8), (7.4, 5.8), (7.4, -5.8))):
        b.solid_cylinder(f"/World/Environment/LightPole_{i}", (px, py, 2.1), 0.08, 4.2, (0.34, 0.38, 0.42), metallic=0.65, collision=True)
        b.solid_box(f"/World/Decor/FloodHead_{i}", (px, py, 4.15), (0.55, 0.25, 0.14), (1.0, 0.98, 0.92), emissive=(2.5, 2.5, 2.3), collision=False)

    b.add_traffic_cone("OutCone_1", 2.2, -2.0)
    b.add_traffic_cone("OutCone_2", -2.2, -3.8)
    for i, (px, py) in enumerate(((-4.2, -0.4), (-1.2, 2.2), (3.2, -0.5), (5.2, -4.2))):
        b.add_patrol_pad(i, px, py)
