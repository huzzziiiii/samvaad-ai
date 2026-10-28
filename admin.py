"""Samvaad admin panel: customer requests and the bank rate table."""
from flask import Blueprint, render_template, request, jsonify

from core import auth
from core import loans as L
from core import advisor
from core.store import get_store, REQUEST_KINDS, REQUEST_STATUSES

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
    return jsonify({
        "counts": store.admin_counts(),
        "backend": store.backend,
        "ai": advisor.provider_label(),
        "kinds": REQUEST_KINDS,
        "statuses": REQUEST_STATUSES,
        "loan_types": L.LOAN_TYPES,
    })


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
