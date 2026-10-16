"""
Read leads from CSV and dial each one (Exotel) or run a local demo call (microphone).
CSV columns: name, phone [, status, outcome, last_called]
"""

import os
import sys
import csv
import time
import argparse
from datetime import datetime

from dotenv import load_dotenv

load_dotenv()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

DEFAULT_CSV = os.path.join(ROOT, "data", "leads.csv")


def load_leads(path: str) -> list[dict]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Leads file not found: {path}")
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    if not rows:
        return []
    required = {"name", "phone"}
    if not required.issubset(set(rows[0].keys())):
        raise ValueError(f"CSV must include columns: {', '.join(sorted(required))}")
    return rows


def save_leads(path: str, fieldnames: list[str], rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def should_skip(lead: dict, retry_failed: bool) -> bool:
    status = (lead.get("status") or "").strip().lower()
    if status in ("completed", "called") and not retry_failed:
        return True
    if status == "skipped":
        return True
    return False


def run_exotel_batch(
    leads: list[dict],
    path: str,
    fieldnames: list[str],
    delay_seconds: float,
    max_calls,
    retry_failed: bool,
) -> None:
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from exotel_caller import initiate_call

    count = 0
    for i, lead in enumerate(leads):
        if max_calls is not None and count >= max_calls:
            break
        if should_skip(lead, retry_failed):
            print(f"Skip {lead.get('name')} ({lead.get('phone')}) — status={lead.get('status')}")
            continue

        name = (lead.get("name") or "there").strip()
        phone = (lead.get("phone") or "").strip()
        if not phone:
            lead["status"] = "error"
            lead["outcome"] = "missing_phone"
            save_leads(path, fieldnames, leads)
            continue

        print(f"\n[{count + 1}] Calling {name} @ {phone}...")
        try:
            initiate_call(phone, lead_name=name, lead_id=str(i))
            lead["status"] = "called"
            lead["last_called"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            count += 1
        except Exception as exc:
            print(f"Failed: {exc}")
            lead["status"] = "error"
            lead["outcome"] = str(exc)[:120]

        save_leads(path, fieldnames, leads)
        if delay_seconds > 0 and count < (max_calls or len(leads)):
            print(f"Waiting {delay_seconds}s before next call...")
            time.sleep(delay_seconds)


def run_twilio_batch(leads, path, fieldnames, delay_seconds, max_calls, retry_failed):
    """Dial each lead through Twilio. app.py must be running at PUBLIC_BASE_URL,
    because Twilio sends the call to its /twilio/... webhooks."""
    from core import twilio_call as tw

    setup = tw.setup_status()
    if not setup["ready"]:
        raise SystemExit("Phone calls aren't set up. Missing: " + ", ".join(setup["missing"]))

    count = 0
    for lead in leads:
        if max_calls is not None and count >= max_calls:
            break
        if should_skip(lead, retry_failed):
            print(f"Skip {lead.get('name')} ({lead.get('phone')}) — status={lead.get('status')}")
            continue
        if not tw.within_calling_hours():
            print("Outside calling hours (CALL_HOURS). Stopping.")
            break

        name = (lead.get("name") or "there").strip()
        phone = (lead.get("phone") or "").strip()
        print(f"\n[{count + 1}] Ritu is calling {name} @ {phone}...")
        try:
            sid = tw.start_call(phone, name)
            lead["status"] = "called"
            print(f"   Twilio call id: {sid}")
            lead["last_called"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            count += 1
        except Exception as exc:
            print(f"Failed: {getattr(exc, 'msg', None) or exc}")
            lead["status"] = "error"
            lead["outcome"] = str(getattr(exc, "msg", None) or exc)[:120]

        save_leads(path, fieldnames, leads)
        if delay_seconds > 0 and (max_calls is None or count < max_calls):
            print(f"Waiting {delay_seconds}s before next call...")
            time.sleep(delay_seconds)


def run_local_batch(leads, max_calls):
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from conversation import run_conversation

    count = 0
    for lead in leads:
        if max_calls is not None and count >= max_calls:
            break
        name = (lead.get("name") or "there").strip()
        phone = (lead.get("phone") or "").strip()
        print(f"\n--- Local demo call for {name} ---")
        run_conversation(lead_name=name, phone=phone or None)
        count += 1
        cont = input("\nCall next lead? [y/N]: ").strip().lower()
        if cont != "y":
            break


def main():
    parser = argparse.ArgumentParser(description="Samvaad AI — CSV lead auto-caller")
    parser.add_argument("--csv", default=DEFAULT_CSV, help="Path to leads CSV")
    parser.add_argument(
        "--mode",
        choices=("twilio", "exotel", "local"),
        default="twilio",
        help="twilio = real phone calls through Twilio; exotel = Exotel; local = mic/speaker demo",
    )
    parser.add_argument("--delay", type=float, default=45.0, help="Seconds between Exotel calls")
    parser.add_argument("--max", type=int, default=None, help="Max leads to dial this run")
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Also dial rows not marked completed/called",
    )
    args = parser.parse_args()

    leads = load_leads(args.csv)
    fieldnames = list(leads[0].keys()) if leads else ["name", "phone", "status", "outcome", "last_called"]
    for col in ("status", "outcome", "last_called"):
        if col not in fieldnames:
            fieldnames.append(col)
    for lead in leads:
        for col in fieldnames:
            lead.setdefault(col, "")

    print(f"Loaded {len(leads)} leads from {args.csv}")

    if args.mode == "local":
        run_local_batch(leads, args.max)
    elif args.mode == "twilio":
        run_twilio_batch(leads, args.csv, fieldnames, args.delay, args.max, args.retry_failed)
    else:
        run_exotel_batch(
            leads, args.csv, fieldnames, args.delay, args.max, args.retry_failed
        )


if __name__ == "__main__":
    main()
