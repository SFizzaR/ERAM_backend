import easyocr
import cv2
import numpy as np
import re
from rapidfuzz import fuzz

# ---------------- OCR ----------------
reader = easyocr.Reader(['en'], gpu=False)

def run_ocr(image_bytes):
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    results = reader.readtext(img)
    return results

# ---------------- BBOX HELPERS ----------------
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

def is_same_row(a, b, tolerance=30):
    return abs(a["y_center"] - b["y_center"]) < tolerance

def is_right_of(a, b):
    return b["x_min"] > a["x_max"]

# ---------------- TEXT NORMALIZATION ----------------
def normalize_text(text):
    text = text.upper()

    replacements = {
        "REALURATON": "REGISTRATION",
        "REGLSTRABON": "REGISTRATION",
        "REGISTRABON": "REGISTRATION",

        "NEMA": "NAME",
        "FATRAT": "FATHER",
        "NAMA": "NAME",

        "PRESANT": "PRESENT",
        "ADDRUSS": "ADDRESS",
        "ADDNESS": "ADDRESS",

        "CONTAC": "CONTACT",
        "NUMBAR": "NUMBER",

        "PENANANT": "PERMANENT",

        "VALLA": "VALID",

        "QUAKICABON": "QUALIFICATION",

        "CNICPAASPON": "CNIC PASSPORT"
    }

    for wrong, correct in replacements.items():
        text = text.replace(wrong, correct)

    # remove junk characters
    text = re.sub(r'[^A-Z0-9/.\- ]', '', text)

    return text.strip()

# ---------------- FIELD DEFINITIONS ----------------
FIELDS = {
    "registration_number": "REGISTRATION NUMBER",
    "cnic": "CNIC",
    "name": "NAME",
    "father_name": "FATHER NAME",
    "present_address": "PRESENT ADDRESS",
    "contact_number": "CONTACT NUMBER",
    "permanent_address": "PERMANENT ADDRESS",
    "registration_date": "REGISTRATION DATE",
    "valid_upto": "VALID UPTO",
    "qualification": "QUALIFICATION"
}

def group_rows(processed, y_threshold=20):
    rows = []

    for item in sorted(processed, key=lambda x: x["stats"]["y_center"]):
        placed = False

        for row in rows:
            if abs(row[0]["stats"]["y_center"] - item["stats"]["y_center"]) < y_threshold:
                row.append(item)
                placed = True
                break

        if not placed:
            rows.append([item])

    # sort each row left → right
    for row in rows:
        row.sort(key=lambda x: x["stats"]["x_min"])

    return rows

# ---------------- CLEAN FIELD VALUES ----------------
def clean_value(field, value):
    if not value:
        return value

    if field == "registration_number":
        match = re.search(r"\d{3,6}-[A-Z0-9]{1,3}", value)
        return match.group() if match else value

    if field == "contact_number":
        match = re.search(r"\d{10,11}", value)
        return match.group() if match else value

    if field == "cnic":
        match = re.search(r"\d{13}", value)
        return match.group() if match else value

    if field in ["registration_date", "valid_upto"]:
        match = re.search(r"\d{2}/\d{2}/\d{4}", value)
        return match.group() if match else value

    return value.strip()

# ---------------- MAIN EXTRACTION ----------------
def extract_pmdc_data(ocr_results):
    processed = []

    for (bbox, text, conf) in ocr_results:
        processed.append({
            "text": normalize_text(text),
            "stats": bbox_stats(bbox),
            "conf": conf
        })

    rows = group_rows(processed)

    data = {key: None for key in FIELDS.keys()}

    for row in rows:
        row_texts = [item["text"] for item in row]

        full_row_text = " ".join(row_texts)

        # 🔹 REGISTRATION NUMBER
        if fuzz.partial_ratio(full_row_text, "REGISTRATION NUMBER") > 75:
            for t in row_texts:
                if re.search(r"\d{3,6}-[A-Z0-9]{1,3}", t):
                    data["registration_number"] = t

        # 🔹 CNIC
        if fuzz.partial_ratio(full_row_text, "CNIC") > 75:
            for t in row_texts:
                if re.search(r"\d{13}", t):
                    data["cnic"] = t

        # 🔹 NAME
        if "NAME" in full_row_text and "FATHER" not in full_row_text:
            if len(row_texts) >= 2:
                data["name"] = row_texts[-1]

        # 🔹 FATHER NAME
        if "FATHER" in full_row_text:
            if len(row_texts) >= 2:
                data["father_name"] = row_texts[-1]

        # 🔹 CONTACT
        if fuzz.partial_ratio(full_row_text, "CONTACT") > 75:
            for t in row_texts:
                if re.search(r"\d{10,11}", t):
                    data["contact_number"] = t

        # 🔹 DATES
        if fuzz.partial_ratio(full_row_text, "REGISTRATION DATE") > 75:
            dates = re.findall(r"\d{2}[-/]\d{2}[-/]\d{4}", full_row_text)
            if len(dates) >= 1:
                data["registration_date"] = dates[0]
            if len(dates) >= 2:
                data["valid_upto"] = dates[1]

        # 🔹 ADDRESS (multi-line handling)
        if "PRESENT ADDRESS" in full_row_text:
            data["present_address"] = " ".join(row_texts[1:])

        if "PERMANENT ADDRESS" in full_row_text:
            data["permanent_address"] = " ".join(row_texts[1:])

    return data

def is_valid_field(field, value):
    if not value:
        return False

    if field == "registration_number":
        return bool(re.search(r"\d{3,6}-[A-Z0-9]{1,3}", value))

    if field == "cnic":
        return bool(re.search(r"\d{13}", value))

    if field == "contact_number":
        return bool(re.search(r"\d{10,11}", value))

    if field in ["registration_date", "valid_upto"]:
        return bool(re.search(r"\d{2}/\d{2}/\d{4}", value))

    if field in "name":
       return (
        value.replace(" ", "").isalpha()
        and len(value.split()) <= 3   # names are shorter
    )
    if field == "father_name":
        return (
        value.replace(" ", "").isalpha()
        and len(value.split()) >= 2   # father names often longer
    )
    if field == "qualification":
        return "MBBS" in value or "BDS" in value

    return True
