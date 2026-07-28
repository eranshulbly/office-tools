#!/usr/bin/env bash
# Cheque OCR fallback sidecar — runs under pm2 as `cheque-ocr` on 127.0.0.1:8110.
# uv provisions Python 3.11 + the deps in an ephemeral env (needs the system
# `tesseract-ocr` binary installed via apt). Bound to localhost only.
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
exec uv run --python 3.11 \
  --with "fastapi" \
  --with "uvicorn[standard]" \
  --with "pytesseract" \
  --with "pillow" \
  uvicorn ocr_service:app --host 127.0.0.1 --port 8110
