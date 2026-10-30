"""Samvaad admin panel: customer requests and the bank rate table."""
from datetime import datetime, timedelta, timezone

from flask import Blueprint, render_template, request, jsonify, Response

from core import auth
from core import loans as L
from core import advisor
from core.store import get_store, REQUEST_KINDS, REQUEST_STATUSES, EVENT_KINDS

bp = Blueprint("admin", __name__)


def _store():
    s = get_store()
    if s is None:
        return None, (jsonify({"error": "The database isn't set up yet."}), 503)
    return s, None


@bp.route("/admin")
@auth.admin_required
def admin_home():
    return render_template("admin.html", active="admin")


@bp.route("/api/admin/summary")
@auth.admin_required
def summary():
    store, err = _store()
    if err:
        return err
    counts = dict(store.admin_counts())
    admins = auth.admin_emails()
    counts["customers"] = sum(1 for p in store.admin_all_profiles() if (p.get("email") or "").lower() not in admins)
    try:
        from datetime import datetime, timedelta, timezone
        ist = timezone(timedelta(hours=5, minutes=30))
        today = datetime.now(ist).date()
        seen = set()
        for e in store.admin_events(500):
            when = datetime.fromisoformat(str(e["created_at"]).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            if when.astimezone(ist).date() == today:
                seen.add(e["user_id"])
        counts["active_today"] = len(seen)
    except Exception:
        counts["active_today"] = None
    return jsonify({
        "counts": counts,
        "event_kinds": EVENT_KINDS,
        "backend": store.backend,
        "ai": advisor.provider_label(),
        "kinds": REQUEST_KINDS,
        "statuses": REQUEST_STATUSES,
        "loan_types": L.LOAN_TYPES,
    })


@bp.route("/api/admin/events")
@auth.admin_required
def events_feed():
    """Everything customers have done, newest first."""
    store, err = _store()
    if err:
        return err
    try:
        limit = max(1, min(200, int(request.args.get("limit") or 60)))
    except ValueError:
        limit = 60
    return jsonify({"events": store.admin_events(limit, before=request.args.get("before") or None)})


def _customer_row(p, loans, reqs):
    mine = [l for l in loans if l["user_id"] == p["user_id"]]
    their = [r for r in reqs if r["user_id"] == p["user_id"]]
    return {
        "user_id": p["user_id"], "name": p.get("name"), "email": p.get("email"), "phone": p.get("phone"),
        "employer": p.get("employer"), "city": p.get("city"), "salary": p.get("salary"),
        "cibil_score": p.get("cibil_score"), "has_report": bool(p.get("cibil_report")),
        "loans": len(mine), "total_outstanding": round(sum(float(l.get("outstanding") or 0) for l in mine)),
        "total_emi": round(sum(float(l.get("emi") or 0) for l in mine)),
        "requests": len(their), "open_requests": sum(1 for r in their if r.get("status") in ("new", "contacted", "in_progress")),
        "joined": p.get("created_at"), "last_seen": p.get("last_seen") or p.get("updated_at"),
    }


@bp.route("/api/admin/customers")
@auth.admin_required
def customers_list():
    store, err = _store()
    if err:
        return err
    admins = auth.admin_emails()
    profiles = [p for p in store.admin_all_profiles() if (p.get("email") or "").lower() not in admins]
    loans = store.admin_all_loans()
    reqs = store.admin_all_requests()
    rows = [_customer_row(p, loans, reqs) for p in profiles]
    rows.sort(key=lambda r: r["last_seen"] or "", reverse=True)
    return jsonify({"customers": rows})


@bp.route("/api/admin/customers/<uid>")
@auth.admin_required
def customer_detail(uid):
    store, err = _store()
    if err:
        return err
    c = store.admin_customer(uid)
    if not c:
        return jsonify({"error": "Customer not found."}), 404
    clean = []
    for row in c["loans"]:
        try:
            loan = L.clean_loan(row)
            loan.update(id=row["id"], source=row.get("source") or "typed", created_at=row.get("created_at"))
            clean.append(loan)
        except ValueError:
            continue
    bank_offers = store.list_banks(active_only=True)
    c["overview"] = L.overview(clean, c["profile"].get("salary"))
    c["transfers"] = L.savings_finder(clean, bank_offers)
    c["profile"]["has_report"] = bool(c["profile"].get("cibil_report"))
    c["profile"].pop("cibil_report", None)   # the path stays on the server
    return jsonify(c)


@bp.route("/admin/customers/<uid>/report.pdf")
@auth.admin_required
def customer_report(uid):
    store, err = _store()
    if err:
        return err
    p = store.get_profile(uid) or {}
    if not p.get("cibil_report"):
        return jsonify({"error": "No report uploaded."}), 404
    try:
        data = store.read_report(p["cibil_report"])
    except Exception:
        return jsonify({"error": "Couldn't fetch the report."}), 502
    name = "".join(ch for ch in (p.get("name") or "customer") if ch.isalnum() or ch in " -_").strip() or "customer"
    return Response(data, headers={"Content-Type": "application/pdf", "Cache-Control": "no-store",
                                   "Content-Disposition": f'inline; filename="CIBIL - {name}.pdf"'})


@bp.route("/api/admin/requests")
@auth.admin_required
def requests_list():
    store, err = _store()
    if err:
        return err
    return jsonify({"requests": store.admin_list_requests()})


@bp.route("/api/admin/requests/<req_id>", methods=["PATCH"])
@auth.admin_required
def request_update(req_id):
    store, err = _store()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    if status is not None and status not in REQUEST_STATUSES:
        return jsonify({"error": "Unknown status."}), 400
    note = data.get("note")
    store.admin_update_request(req_id, status=status, note=str(note)[:2000] if note is not None else None)
    return jsonify({"ok": True})


@bp.route("/admin/export.xlsx")
@auth.admin_required
def export_excel():
    """Every request, customer and loan as an Excel file."""
    from core.export import build_workbook
    store, err = _store()
    if err:
        return err
    data = build_workbook(store)
    stamp = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
    return Response(data, headers={
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": f'attachment; filename="samvaad-{stamp}.xlsx"',
        "Cache-Control": "no-store",
    })


def _clean_bank(data):
    name = str(data.get("name") or "").strip()[:60]
    if not name:
        raise ValueError("Bank name is missing.")
    product = data.get("product")
    if product not in L.LOAN_TYPES:
        raise ValueError("Pick a loan type.")
    try:
        lo = float(data.get("rate_min"))
        hi = float(data.get("rate_max") or lo)
        fee = float(data.get("processing_fee_pct") or 0)
        tenure = int(float(data.get("max_tenure_months") or 0)) or None
    except (TypeError, ValueError):
        raise ValueError("Rates, fee and tenure must be numbers.")
    if not (0 < lo <= 60) or hi < lo or hi > 60:
        raise ValueError("Rates must be yearly percentages, with the 'up to' rate at least the 'from' rate.")
    if not (0 <= fee <= 10):
        raise ValueError("Processing fee should be a percentage between 0 and 10.")
    return {"name": name, "product": product, "rate_min": lo, "rate_max": hi, "processing_fee_pct": fee,
            "max_tenure_months": tenure, "active": bool(data.get("active", True)),
            "notes": str(data.get("notes") or "").strip()[:200]}


@bp.route("/api/admin/banks")
@auth.admin_required
def banks_list():
    store, err = _store()
    if err:
        return err
    return jsonify({"banks": store.list_banks()})


@bp.route("/api/admin/banks", methods=["POST"])
@auth.admin_required
def bank_add():
    store, err = _store()
    if err:
        return err
    try:
        bank = _clean_bank(request.get_json(silent=True) or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    store.upsert_bank(bank)
    return jsonify({"banks": store.list_banks()})


@bp.route("/api/admin/banks/<bank_id>", methods=["PUT"])
@auth.admin_required
def bank_edit(bank_id):
    store, err = _store()
    if err:
        return err
    try:
        bank = _clean_bank(request.get_json(silent=True) or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    store.upsert_bank(bank, bank_id)
    return jsonify({"banks": store.list_banks()})


@bp.route("/api/admin/banks/<bank_id>", methods=["DELETE"])
@auth.admin_required
def bank_delete(bank_id):
    store, err = _store()
    if err:
        return err
    store.delete_bank(bank_id)
    return jsonify({"banks": store.list_banks()})
