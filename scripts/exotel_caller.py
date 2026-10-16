"""
Place outbound calls via Exotel Connect API.
Set EXOTEL_SID, EXOTEL_TOKEN, EXOTEL_VIRTUAL_NUMBER, and EXOTEL_CALLBACK_BASE_URL in .env
(EXOTEL_CALLBACK_BASE_URL = public app URL, e.g. https://your-app.up.railway.app)
"""

import os
import sys
import base64
import urllib.parse

import requests
from dotenv import load_dotenv

load_dotenv()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def _credentials():
    sid = os.getenv("EXOTEL_SID")
    token = os.getenv("EXOTEL_TOKEN")
    if not sid or not token:
        raise RuntimeError("EXOTEL_SID and EXOTEL_TOKEN must be set in .env")
    return sid, token


def _auth_header():
    sid, token = _credentials()
    encoded = base64.b64encode(f"{sid}:{token}".encode()).decode()
    return {"Authorization": f"Basic {encoded}"}


def normalize_phone(phone: str, default_country_code: str = "91") -> str:
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) == 10:
        return default_country_code + digits
    if digits.startswith("0") and len(digits) == 11:
        return default_country_code + digits[1:]
    return digits


def initiate_call(
    to_number: str,
    lead_name: str = "there",
    lead_id=None,
    status_callback: bool = True,
) -> dict:
    """
    Start an outbound call. Exotel will GET /exotel/voice when the callee answers.
    """
    sid, _ = _credentials()
    from_number = os.getenv("EXOTEL_VIRTUAL_NUMBER")
    base_url = (os.getenv("EXOTEL_CALLBACK_BASE_URL") or "").rstrip("/")
    if not from_number:
        raise RuntimeError("EXOTEL_VIRTUAL_NUMBER must be set in .env")
    if not base_url:
        raise RuntimeError(
            "EXOTEL_CALLBACK_BASE_URL must be your public URL (Railway app URL)"
        )

    to = normalize_phone(to_number)
    params = {"name": lead_name}
    if lead_id:
        params["lead_id"] = lead_id
    voice_url = f"{base_url}/exotel/voice?{urllib.parse.urlencode(params)}"

    url = f"https://api.exotel.com/v1/Accounts/{sid}/Calls/connect.json"
    payload = {
        "From": from_number,
        "To": to,
        "CallerId": from_number,
        "Url": voice_url,
        "CallType": "trans",
    }
    if status_callback:
        payload["StatusCallback"] = f"{base_url}/exotel/status"

    response = requests.post(url, data=payload, headers=_auth_header(), timeout=30)
    response.raise_for_status()
    data = response.json()
    print(f"Exotel call initiated → {to} ({lead_name})")
    return data


def get_call_details(call_sid: str) -> dict:
    sid, _ = _credentials()
    url = f"https://api.exotel.com/v1/Accounts/{sid}/Calls/{call_sid}.json"
    response = requests.get(url, headers=_auth_header(), timeout=30)
    response.raise_for_status()
    return response.json()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Place one Exotel outbound call")
    parser.add_argument("phone", help="Customer phone (10 digits or with country code)")
    parser.add_argument("--name", default="there", help="Lead name for greeting")
    args = parser.parse_args()
    initiate_call(args.phone, lead_name=args.name)
