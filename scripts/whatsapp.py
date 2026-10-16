"""
WhatsApp follow-ups for interested leads (Twilio WhatsApp API).
Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886)
"""

import os
import sys
import json
import argparse
from datetime import datetime

from dotenv import load_dotenv

load_dotenv()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TRANSCRIPT_DIR = os.path.join(ROOT, "data", "transcripts")


def _twilio_client():
    from twilio.rest import Client

    sid = os.getenv("TWILIO_ACCOUNT_SID")
    token = os.getenv("TWILIO_AUTH_TOKEN")
    if not sid or not token:
        raise RuntimeError("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required")
    return Client(sid, token)


def normalize_whatsapp_to(phone: str) -> str:
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) == 10:
        digits = "91" + digits
    return f"whatsapp:+{digits}"


def send_whatsapp(to_phone: str, body: str) -> str:
    client = _twilio_client()
    from_num = os.getenv("TWILIO_WHATSAPP_FROM")
    if not from_num:
        raise RuntimeError("TWILIO_WHATSAPP_FROM required (e.g. whatsapp:+14155238886)")
    if not from_num.startswith("whatsapp:"):
        from_num = f"whatsapp:{from_num}"

    message = client.messages.create(body=body, from_=from_num, to=normalize_whatsapp_to(to_phone))
    print(f"Sent WhatsApp → {to_phone} (sid={message.sid})")
    return message.sid


def followup_message(name: str = "there") -> str:
    return (
        f"Hi {name}, this is Ritu from the loan advisory team 👋\n\n"
        "Thank you for speaking with us today. As discussed, please share your latest "
        "payslip here on WhatsApp so we can share your personalised loan offer within 30 minutes.\n\n"
        "Reply STOP if you prefer not to receive messages."
    )


def load_interested_transcripts() -> list[dict]:
    if not os.path.isdir(TRANSCRIPT_DIR):
        return []
    results = []
    for filename in os.listdir(TRANSCRIPT_DIR):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(TRANSCRIPT_DIR, filename)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if data.get("outcome") != "interested":
            continue
        phone = data.get("phone") or data.get("lead_phone")
        if not phone:
            continue
        data["_file"] = filename
        results.append(data)
    return results


def send_from_transcripts(dry_run: bool = False) -> int:
    sent = 0
    for call in load_interested_transcripts():
        name = call.get("lead_name") or call.get("name") or "there"
        phone = call.get("phone") or call.get("lead_phone")
        body = followup_message(name)
        if dry_run:
            print(f"[dry-run] Would send to {phone}: {body[:80]}...")
        else:
            send_whatsapp(phone, body)
            call["whatsapp_sent_at"] = datetime.now().isoformat()
            path = os.path.join(TRANSCRIPT_DIR, call["_file"])
            with open(path, "w", encoding="utf-8") as f:
                json.dump({k: v for k, v in call.items() if k != "_file"}, f, ensure_ascii=False, indent=2)
        sent += 1
    print(f"Processed {sent} interested lead(s).")
    return sent


def send_single(phone: str, name: str) -> None:
    send_whatsapp(phone, followup_message(name))


def main():
    parser = argparse.ArgumentParser(description="WhatsApp follow-up for Samvaad AI leads")
    sub = parser.add_subparsers(dest="command", required=True)

    p_one = sub.add_parser("send", help="Send one message")
    p_one.add_argument("phone")
    p_one.add_argument("--name", default="there")

    p_batch = sub.add_parser("from-transcripts", help="Message interested leads from saved transcripts")
    p_batch.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    if args.command == "send":
        send_single(args.phone, args.name)
    elif args.command == "from-transcripts":
        send_from_transcripts(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
