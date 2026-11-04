"""Read a CIBIL (or other bureau) credit report PDF.

The customer uploads the PDF they downloaded free from cibil.com. Claude reads
it and returns ONLY what the app needs: the score, the report date, and each
open loan or card (type, lender, amount left, EMI, rate, month opened).
Names, PAN, addresses, phone numbers and account numbers are never returned
or stored by the app. The PDF itself is kept in private storage for the
Credwise team.

Reader: Claude when ANTHROPIC_API_KEY is set. Otherwise Gemini, but only when
REPORT_AI=gemini is set, because the report holds the customer's PAN, address
and loan history: use a Gemini key with billing on (Google's paid tier doesn't
use the data to improve its products). With neither, the PDF is saved for the
team and customers type their score.
"""
import base64
import io
import json
import os
import re

import requests

from core import loans as L

MAX_BYTES = 4 * 1024 * 1024   # Vercel accepts request bodies up to about 4.5 MB

PROMPT = """This is an Indian credit bureau report (usually TransUnion CIBIL).
Extract the data below and reply with ONE JSON object only, no other text.

{
  "bureau": "CIBIL" | "Experian" | "Equifax" | "CRIF" | "unknown",
  "score": integer 300-900 or null,
  "report_date": "YYYY-MM-DD" or null,
  "accounts": [
    {
      "type": one of "personal","home","car","two_wheeler","credit_card","education","gold","business","consumer","other",
      "lender": member/bank name as printed, e.g. "HDFC Bank",
      "outstanding": current balance in rupees as a number,
      "emi": EMI / instalment amount in rupees as a number, or null if not shown,
      "rate": interest rate % per year as a number, or null if not shown,
      "opened": "Mon YYYY" or null
    }
  ]
}

Rules:
- Include ONLY accounts that are open/active with a current balance above zero. Skip closed, written-off-and-closed, and zero-balance accounts.
- Map account types: Personal Loan -> personal; Housing Loan / Property Loan -> home; Auto Loan / Used Car -> car;
  Two-Wheeler Loan -> two_wheeler; Credit Card -> credit_card; Education Loan -> education; Gold Loan -> gold;
  Business Loan -> business; Consumer Loan -> consumer; anything else -> other.
- Use numbers only (no commas, no rupee sign). If a value isn't in the report, use null. Never guess.
- Do NOT include names, PAN, dates of birth, addresses, phone numbers, emails or account numbers anywhere.
- If this isn't a credit report, reply {"error": "not_a_credit_report"}."""


class ReportError(RuntimeError):
    pass


def reader():
    if os.getenv("ANTHROPIC_API_KEY"):
        return "claude"
    if os.getenv("GEMINI_API_KEY") and (os.getenv("REPORT_AI") or "").lower() == "gemini":
        return "gemini"
    return None


def enabled():
    return reader() is not None


def unlock(data, password=None):
    """Return PDF bytes Claude can read. Password-protected reports are
    decrypted with the password the customer types (often their date of birth)."""
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return data
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception:
        raise ReportError("That file doesn't look like a PDF. Choose the report PDF from CIBIL.")
    if not reader.is_encrypted:
        return data
    if not password:
        raise ReportError("PASSWORD_NEEDED")
    try:
        ok = reader.decrypt(password)
    except Exception:
        ok = 0
    if not ok:
        raise ReportError("WRONG_PASSWORD")
    out = PdfWriter()
    for page in reader.pages:
        out.add_page(page)
    buf = io.BytesIO()
    out.write(buf)
    return buf.getvalue()


def _clean(raw):
    """Keep only the fields we use, as safe types."""
    def num(v):
        try:
            v = float(str(v).replace(",", "").replace("₹", "").strip())
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None

    score = raw.get("score")
    try:
        score = int(score)
        if not 300 <= score <= 900:
            score = None
    except (TypeError, ValueError):
        score = None
    date = raw.get("report_date")
    if not (isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date)):
        date = None
    accounts = []
    for a in (raw.get("accounts") or [])[:25]:
        if not isinstance(a, dict):
            continue
        out = num(a.get("outstanding"))
        if not out:
            continue
        t = a.get("type") if a.get("type") in L.LOAN_TYPES else "other"
        rate = num(a.get("rate"))
        if rate and rate > 60:
            rate = None
        accounts.append({
            "type": t,
            "type_label": L.LOAN_TYPES[t],
            "lender": str(a.get("lender") or "").strip()[:60],
            "outstanding": round(out, 0),
            "emi": round(num(a.get("emi")), 0) if num(a.get("emi")) else None,
            "rate": rate,
            "opened": str(a.get("opened") or "").strip()[:12] or None,
        })
    return {"bureau": str(raw.get("bureau") or "unknown")[:12], "score": score, "report_date": date, "accounts": accounts}


def _gemini_text(pdf_bytes):
    """Gemini reads the PDF directly. Tries a backup model if the first is busy."""
    from core.advisor import GEMINI_FALLBACKS
    first = os.getenv("GEMINI_REPORT_MODEL") or os.getenv("GEMINI_MODEL") or GEMINI_FALLBACKS[0]
    models = [first] + [m for m in GEMINI_FALLBACKS[:2] if m != first]
    body = {
        "contents": [{"role": "user", "parts": [
            {"inline_data": {"mime_type": "application/pdf", "data": base64.b64encode(pdf_bytes).decode("ascii")}},
            {"text": PROMPT},
        ]}],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 4000, "responseMimeType": "application/json"},
    }
    for model in models[:2]:
        try:
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"},
                json=body, timeout=24,
            )
        except requests.RequestException:
            continue
        if r.status_code in (429, 500, 502, 503, 504, 404):
            continue
        if r.status_code >= 400:
            raise ReportError(f"Couldn't read the report ({r.status_code}). Type your score instead.")
        try:
            parts = r.json()["candidates"][0]["content"]["parts"]
            return "".join(p.get("text", "") for p in parts)
        except (KeyError, IndexError, ValueError):
            continue
    raise ReportError("Lots of reports are being read right now. Try again in a minute.")


def read(pdf_bytes):
    which = reader()
    if not which:
        raise ReportError("Reading reports isn't switched on yet. Type your score instead.")
    if which == "gemini":
        return _parse(_gemini_text(pdf_bytes))
    model = os.getenv("CLAUDE_REPORT_MODEL") or os.getenv("CLAUDE_MODEL") or "claude-sonnet-5-5"
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={
                "model": model, "max_tokens": 2000, "temperature": 0,
                "messages": [{"role": "user", "content": [
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                    "data": base64.b64encode(pdf_bytes).decode("ascii")}},
                    {"type": "text", "text": PROMPT},
                ]}],
            },
            timeout=55,
        )
    except requests.RequestException:
        raise ReportError("Couldn't read the report just now. Try again in a minute.")
    if r.status_code == 429:
        raise ReportError("Lots of reports are being read right now. Try again in a minute.")
    if r.status_code >= 400:
        raise ReportError(f"Couldn't read the report ({r.status_code}). Type your score instead.")
    text = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
    return _parse(text)


def _parse(text):
    m = re.search(r"\{.*\}", text, re.S)
    try:
        raw = json.loads(m.group(0)) if m else {}
    except ValueError:
        raw = {}
    if raw.get("error") == "not_a_credit_report":
        raise ReportError("That doesn't look like a credit report. Upload the PDF you downloaded from CIBIL.")
    result = _clean(raw)
    if not result["score"] and not result["accounts"]:
        raise ReportError("We couldn't find a score or loans in that report. Type your score instead.")
    return result
