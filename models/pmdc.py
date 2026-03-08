
from typing import List, Tuple, Any
import re


def bbox_stats(bbox):
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return {
        "x_min": min(xs),
        "x_max": max(xs),
        "y_min": min(ys),
        "y_max": max(ys),
        "x_center": sum(xs) / len(xs),
        "y_center": sum(ys) / len(ys)
    }


def is_vertically_aligned(a, b, tolerance=10):
    return not (
        b["y_max"] < a["y_min"] - tolerance or
        b["y_min"] > a["y_max"] + tolerance
    )



def is_right_of(label, candidate):
    return candidate["x_min"] > label["x_max"]


def extract_name_and_registration(ocr_results):
    import re

    parsed = []

    for bbox, text, conf in ocr_results:
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]

        parsed.append({
            "text": text.strip(),
            "conf": float(conf),
            "x_min": min(xs),
            "x_max": max(xs),
            "y_center": sum(ys) / len(ys)
        })

    registration_number = None
    name = None

    # -------- FIND REGISTRATION --------
    for item in parsed:
        if re.search(r"registration number", item["text"], re.IGNORECASE):
            label = item
            break
    else:
        label = None

    if label:
        right_side = [
            p for p in parsed
            if p["x_min"] > label["x_max"] and p["conf"] > 0.3
        ]

        if right_side:
            closest = min(
                right_side,
                key=lambda p: abs(p["y_center"] - label["y_center"])
            )
            registration_number = closest["text"]

    # -------- FIND NAME --------
    for item in parsed:
        if re.fullmatch(r"name", item["text"].strip(), re.IGNORECASE):
            label = item
            break
    else:
        label = None

    if label:
        right_side = [
            p for p in parsed
            if p["x_min"] > label["x_max"] and p["conf"] > 0.3
        ]

        if right_side:
            closest = min(
                right_side,
                key=lambda p: abs(p["y_center"] - label["y_center"])
            )
            name = closest["text"]

    for item in parsed:
        if re.search(r"father name", item["text"], re.IGNORECASE):
            label = item
            break
    else:
        label = None

    if label:
        right_side = [
            p for p in parsed
            if p["x_min"] > label["x_max"] and p["conf"] > 0.3
        ]

        if right_side:
            closest = min(
                right_side,
                key=lambda p: abs(p["y_center"] - label["y_center"])
            )
            fathername = closest["text"]
        
    return registration_number, name, fathername



__all__ = ["extract_name_and_registration"]
