"""tokens.json 색 대비(WCAG 2.x)와 노란·갈색 금지를 검사한다. 표준 라이브러리만 쓴다.

실행: python3 design/check_contrast.py  → 통과하면 "contrast OK"
"""
import colorsys
import json
from pathlib import Path

TOKENS = Path(__file__).resolve().parent.parent / "apps" / "mobile" / "lib" / "tokens.json"

COLOR_KEYS = {
    "primary", "onPrimary", "bubbleOther", "onBubbleOther", "background", "surface", "text",
    "textMuted", "border", "hintBg", "hintText", "mirror", "onMirror", "danger",
}
# (전경, 배경) — 두 모드 모두 4.5:1 이상
PAIRS = [
    ("text", "background"),
    ("textMuted", "background"),
    ("onPrimary", "primary"),
    ("onBubbleOther", "bubbleOther"),
    ("hintText", "hintBg"),
    ("onMirror", "mirror"),
    ("danger", "background"),
]
MIN_RATIO = 4.5


def rgb(hex_color: str) -> tuple[float, float, float]:
    h = hex_color.lstrip("#")
    assert len(h) == 6, f"#RRGGBB 형식이 아님: {hex_color}"
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return r, g, b


def luminance(hex_color: str) -> float:
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb(hex_color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def is_yellow_brown(hex_color: str) -> bool:
    """HSL 색상각 20°~65°(갈색~노랑) + 채도 > 0.5 + 명도 < 0.9. 명도 0.9 이상인 아주 옅은 색은 제외."""
    h, l, s = colorsys.rgb_to_hls(*rgb(hex_color))
    return 20 <= h * 360 <= 65 and s > 0.5 and l < 0.9


def check(tokens: dict) -> list[str]:
    errors: list[str] = []
    for mode in ("light", "dark"):
        colors = tokens[mode]
        missing = COLOR_KEYS - colors.keys()
        if missing:
            errors.append(f"{mode}: 빠진 색 키 {sorted(missing)}")
            continue
        for fg, bg in PAIRS:
            r = contrast(colors[fg], colors[bg])
            if r < MIN_RATIO:
                errors.append(f"{mode}: {fg} {colors[fg]} / {bg} {colors[bg]} = {r:.2f} < {MIN_RATIO}")
        for key, value in colors.items():
            if is_yellow_brown(value):
                errors.append(f"{mode}: {key} {value} 노란·갈색 계열")
    return errors


def _self_test() -> None:
    assert round(contrast("#000000", "#FFFFFF"), 2) == 21.0
    assert contrast("#777777", "#777777") == 1.0
    assert is_yellow_brown("#FEE500")       # 카톡 노랑
    assert is_yellow_brown("#A16207")       # 갈색 쪽 노랑
    assert is_yellow_brown("#8B5A2B")       # 갈색 (색상각 29°)
    assert not is_yellow_brown("#FFF7ED")   # 아주 옅은 배경은 제외
    assert not is_yellow_brown("#0F766E")   # 틸


if __name__ == "__main__":
    _self_test()
    problems = check(json.loads(TOKENS.read_text(encoding="utf-8")))
    if problems:
        raise SystemExit("contrast FAIL\n" + "\n".join(problems))
    print("contrast OK")
