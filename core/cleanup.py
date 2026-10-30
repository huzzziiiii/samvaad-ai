"""Housekeeping that runs once a day (Vercel cron -> /api/cron/cleanup).

RBI's credit information rules say a CIBIL report fetched or kept by someone who
isn't a bank or NBFC must be deleted within 6 months. We delete the PDF after
180 days. The score and the loans the customer chose to keep stay in their account.
"""
from datetime import datetime, timedelta, timezone

KEEP_REPORT_DAYS = 180


def run(store):
    before = (datetime.now(timezone.utc) - timedelta(days=KEEP_REPORT_DAYS)).isoformat(timespec="seconds")
    deleted, failed = 0, 0
    for row in store.old_reports(before) or []:
        try:
            store.delete_report(row["cibil_report"])
            store.upsert_profile(row["user_id"], {"cibil_report": None, "cibil_report_at": None})
            deleted += 1
        except Exception:
            failed += 1
    return {"reports_deleted": deleted, "failed": failed, "older_than": before}
