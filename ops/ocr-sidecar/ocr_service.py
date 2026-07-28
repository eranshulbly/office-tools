"""
Cheque OCR fallback sidecar (Tesseract). Runs on the app box, bound to localhost.

Purpose: when the AI vision path (Gemini via the S9 gateway) is unavailable —
quota exhausted, provider down, or the box has no route to Gemini — the app falls
back to THIS service so managers still get the PRINTED cheque fields pre-filled
(cheque no, MICR, IFSC, account no, printed amount, ISO date) instead of typing
everything. It is best-effort: Tesseract is weak on handwriting and the MICR font,
so the manager always reviews.

Endpoint:
  POST /ocr        { "image": "<data-url or base64>" }  -> { "text": "...", "fields": {...} }
  GET  /health     -> { "ok": true }

No image is stored — decoded in memory, OCR'd, discarded (extract-and-forget).
"""
import base64
import io
import re

from fastapi import FastAPI
from pydantic import BaseModel
import pytesseract
from PIL import Image, ImageOps

app = FastAPI()


class OcrRequest(BaseModel):
    image: str  # data-URL ("data:image/...;base64,....") or bare base64


def _normalize_date(s: str) -> str | None:
    s = s.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return s
    # dd/mm/yyyy or dd-mm-yyyy (Indian convention: day first)
    m = re.match(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$", s)
    if m:
        d, mo, y = m.groups()
        if len(y) == 2:
            y = "20" + y
        try:
            di, moi = int(d), int(mo)
            if 1 <= di <= 31 and 1 <= moi <= 12:
                return f"{y}-{moi:02d}-{di:02d}"
        except ValueError:
            return None
    return None


def parse_fields(text: str) -> dict:
    """Heuristic extraction of PRINTED cheque fields from raw OCR text."""
    fields: dict[str, str] = {}
    flat = " ".join(text.split())

    # IFSC — 4 letters, then 0, then 6 alphanumerics (11 chars total).
    m = re.search(r"\b([A-Z]{4}0[A-Z0-9]{6})\b", flat)
    if m:
        fields["ifsc"] = m.group(1)

    # Amount in figures — after Rs / ₹ / INR.
    m = re.search(r"(?:Rs\.?|₹|INR)\s*([\d,]+(?:\.\d{1,2})?)", flat, re.I)
    if m:
        amt = m.group(1).replace(",", "")
        if amt.strip("."):
            fields["amount"] = amt

    # Cheque number — near a "cheque no" label, else a lone 6-digit run.
    m = re.search(r"(?:cheque\s*no\.?|ch(?:eque)?\s*no\.?)\s*[:\-]?\s*(\d{6,})", flat, re.I)
    if m:
        fields["cheque_number"] = m.group(1)

    # Account number — near an "a/c" label.
    m = re.search(r"(?:a/?c\.?\s*(?:no\.?)?)\s*[:\-]?\s*(\d{9,18})", flat, re.I)
    if m:
        fields["account_number"] = m.group(1)

    # MICR — near a "MICR" label, else a standalone 9-digit run.
    m = re.search(r"MICR\s*[:\-]?\s*(\d{9})", flat, re.I) or re.search(r"(?<!\d)(\d{9})(?!\d)", flat)
    if m:
        fields["micr_code"] = m.group(1)

    # Date — try labelled first, then any date-looking token.
    for cand in re.findall(r"\d{4}-\d{2}-\d{2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}", flat):
        norm = _normalize_date(cand)
        if norm:
            fields["cheque_date"] = norm
            break

    return fields


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
def ocr(req: OcrRequest):
    data = req.image
    if data.startswith("data:") and "," in data:
        data = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(data)
        img = Image.open(io.BytesIO(raw))
        # Grayscale + autocontrast helps Tesseract on scanned cheques.
        img = ImageOps.autocontrast(img.convert("L"))
        text = pytesseract.image_to_string(img)
    except Exception as e:  # noqa: BLE001 — best-effort; never 500 the caller's fallback
        return {"text": "", "fields": {}, "error": str(e)}
    return {"text": text, "fields": parse_fields(text)}


@app.post("/osd")
def osd(req: OcrRequest):
    """
    Orientation detection (Tesseract OSD). Returns how many degrees the image
    must be rotated CLOCKWISE to read upright, plus Tesseract's confidence.

    This exists because vision models are unreliable at self-reporting
    orientation — they happily read an upside-down cheque and answer "0". OSD is
    purpose-built for the job and deterministic. Never raises: on failure it
    reports 0 (leave the image alone) so upload is never blocked.
    """
    data = req.image
    if data.startswith("data:") and "," in data:
        data = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(data)
        img = ImageOps.autocontrast(Image.open(io.BytesIO(raw)).convert("L"))
        info = pytesseract.image_to_osd(img, output_type=pytesseract.Output.DICT)
        # Tesseract's "rotate" is the clockwise correction to apply.
        rotate = int(info.get("rotate", 0)) % 360
        conf = float(info.get("orientation_conf", 0) or 0)
        return {"rotate": rotate, "confidence": conf}
    except Exception as e:  # noqa: BLE001 — best-effort, never break the upload
        return {"rotate": 0, "confidence": 0.0, "error": str(e)}
