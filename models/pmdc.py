import re

# Helper to compute bbox center
def bbox_stats(bbox):
    xs = [p[0] for p in bbox]
    ys = [p[1] for p in bbox]
    return {
        "x_min": min(xs),
        "x_max": max(xs),
        "y_min": min(ys),
        "y_max": max(ys),
        "x_center": sum(xs) / 4,
        "y_center": sum(ys) / 4
    }

# Relative position helpers
def is_same_row(a, b, tolerance=40):
    return abs(a["y_center"] - b["y_center"]) < tolerance

def is_right_of(a, b):
    return b["x_min"] > a["x_max"]

# Normalize common OCR mistakes in text
def normalize_text(text):
    replacements = {
        "YIDE": "VIDE",
        "UIDE": "VIDE",
        "PMECC": "PMDC",
        "COUNCI": "COUNCIL",
        "N0": "NO",
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    return text

# Regex pattern for PMDC number
PMDC_REGEX = re.compile(r"\b[0-9A-Z]{4,6}[-–][0-9A-Z]\b")


def normalize_pmdc_format(raw):
    raw = raw.upper().replace("–", "-")
    if "-" not in raw:
        return None

    left, right = raw.split("-")

    digit_map = {
        "O": "0", "I": "1", "L": "1", "S": "5",
        "B": "8", "G": "6", "Z": "2"
    }
    left_norm = "".join(digit_map.get(c, c) for c in left if c.isalnum())

    letter_map = {
        "0": "D", "5": "S", "1": "I",
        "2": "Z", "8": "B", "6": "G"
    }
    right_norm = letter_map.get(right, right)

    # 🔒 FINAL HARD RULES
    if not left_norm.isdigit():
        return None
    if not right_norm.isalpha() or len(right_norm) != 1:
        return None

    return f"{left_norm}-{right_norm}"


def generate_pmdc_variants(pmdc):
    left, right = pmdc.split("-")
    variants = {pmdc}

    # If OCR confused last char
    if right == "O":
        variants.add(f"{left}-D")
    elif right == "D":
        variants.add(f"{left}-O")
    elif right == "Q":
        variants.add(f"{left}-O")

    return list(variants)

def extract_pmdc_from_ocr(ocr_results):
    label_bbox = None
    pmdc_candidates = []

    # Step 1: Find label ("Vide No") and gather PMDC candidates
    for bbox, text, confidence in ocr_results:
        normalized_text = normalize_text(text)

        # Check if the normalized text contains "VIDE NO"
        if "VIDE NO" in normalized_text:
            label_bbox = bbox_stats(bbox)

        # Use regex to find potential PMDC formats
        if PMDC_REGEX.search(normalized_text):
            pmdc_candidates.append(normalize_pmdc_format(normalized_text))

    # Step 2: Clean and validate PMDC candidates
    valid_pmdcs = []
    for candidate in pmdc_candidates:
        candidate_variants = generate_pmdc_variants(candidate)
        valid_pmdcs.extend(candidate_variants)

    return valid_pmdcs, label_bbox
