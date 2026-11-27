"""Login codes by SMS, sent through MSG91.

Supabase makes the 6-digit code and checks it when the customer types it in.
It hands each code to /api/hooks/send-sms (a "Send SMS hook"), and that route
calls send_otp() below to deliver it through MSG91.

Set in Vercel:
  MSG91_AUTH_KEY        your MSG91 auth key (mark it Sensitive)
  MSG91_TEMPLATE_ID     the MSG91 template id of your DLT-approved OTP message
  MSG91_OTP_VAR         the variable name in that template, default "OTP"
  SEND_SMS_HOOK_SECRET  the secret Supabase shows when you create the hook
"""
import base64
import hashlib
import hmac
import os
import re
import time

import requests


class SmsError(RuntimeError):
    pass


def configured():
    return bool(os.getenv("MSG91_AUTH_KEY") and os.getenv("MSG91_TEMPLATE_ID"))


def indian_mobile(phone):
    """'+91 98765 43210', '919876543210' or '9876543210' -> '919876543210', else None."""
    d = re.sub(r"\D", "", phone or "")
    if len(d) == 10:
        d = "91" + d
    return d if re.fullmatch(r"91[6-9]\d{9}", d) else None


def send_otp(phone, otp):
    mobile = indian_mobile(phone)
    if not mobile:
        raise SmsError("Only Indian mobile numbers can get a login code.")
    if not re.fullmatch(r"\d{4,8}", str(otp or "")):
        raise SmsError("Bad code from Supabase.")
    if not configured():
        raise SmsError("MSG91 isn't set up on the server yet.")
    var = os.getenv("MSG91_OTP_VAR") or "OTP"
    try:
        r = requests.post(
            "https://control.msg91.com/api/v5/flow",
            headers={"authkey": os.environ["MSG91_AUTH_KEY"], "accept": "application/json",
                     "content-type": "application/json"},
            json={"template_id": os.environ["MSG91_TEMPLATE_ID"], "short_url": "0",
                  "recipients": [{"mobiles": mobile, var: str(otp)}]},
            timeout=10,
        )
    except requests.RequestException as exc:
        raise SmsError(f"Couldn't reach MSG91 ({type(exc).__name__}).")
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code >= 400 or str(data.get("type", "")).lower() == "error":
        raise SmsError(f"MSG91 refused the message ({r.status_code}): {str(data.get('message', ''))[:150]}")
    return True


def verify_hook(body, headers):
    """Check that a Send SMS hook call really came from our Supabase project
    (Standard Webhooks signature). Returns True or raises SmsError."""
    secret = os.getenv("SEND_SMS_HOOK_SECRET", "")
    if not secret:
        raise SmsError("SEND_SMS_HOOK_SECRET isn't set.")
    raw = secret.split("whsec_", 1)[-1]
    try:
        key = base64.b64decode(raw)
    except Exception:
        raise SmsError("SEND_SMS_HOOK_SECRET doesn't look right. Copy it again from Supabase.")
    msg_id = headers.get("webhook-id", "")
    stamp = headers.get("webhook-timestamp", "")
    sigs = headers.get("webhook-signature", "")
    if not (msg_id and stamp and sigs):
        raise SmsError("Missing signature.")
    try:
        if abs(time.time() - int(stamp)) > 300:
            raise SmsError("Signature is too old.")
    except ValueError:
        raise SmsError("Bad timestamp.")
    signed = f"{msg_id}.{stamp}.".encode() + body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    for part in sigs.split():
        version, _, sig = part.partition(",")
        if version == "v1" and hmac.compare_digest(sig, expected):
            return True
    raise SmsError("Signature doesn't match.")
