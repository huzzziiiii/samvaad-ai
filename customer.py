"""The Samvaad customer app: sign-in, loans, plans, savings, Ask Ritu, requests."""
import base64
import os
import tempfile

from flask import Blueprint, render_template, request, jsonify, redirect, url_for, make_response

from core import auth
from core import loans as L
from core import advisor
from core import limits
from core.store import get_store, REQUEST_KINDS, now as store_now

bp = Blueprint("customer", __name__)


def store_or_error():
    s = get_store()
    if s is None:
        return None, (jsonify({"error": "The database isn't set up yet. Add SUPABASE_URL and SUPABASE_SERVICE_KEY."}), 503)
    return s, None


def user_id():
    return auth.current_user()["id"]


def load_loans(store, uid):
    """Loans from the database, normalised for the maths engine."""
    out = []
    for row in store.list_loans(uid):
        try:
            loan = L.clean_loan(row)
        except ValueError:
            continue
        loan["id"] = row["id"]
        out.append(loan)
    return out


def offers(store):
    return store.list_banks(active_only=True)


def log(store, kind, summary="", details=None, uid=None):
    """Record what the customer did, for the admin activity feed. Never breaks the request."""
    if auth.is_admin():
        return
    try:
        store.log_event(uid or user_id(), kind, summary, details)
    except Exception:
        pass


def loan_line(l):
    return f"{L.LOAN_TYPES.get(l.get('type'), 'Loan')} · {l.get('lender') or 'lender not given'} · {L.inr(l.get('outstanding') or 0)} at {advisor.pct(l.get('rate') or 0)}"


# ------------------------------------------------------------------ pages

@bp.route("/login")
def login():
    if auth.current_user():
        return redirect(request.args.get("next") or url_for("customer.app_home"))
    return render_template("login.html", active="login", config=auth.public_config(),
                           next=request.args.get("next", ""))


def _asset_version():
    """Changes on every deploy, so phones load the new app files."""
    sha = os.getenv("VERCEL_GIT_COMMIT_SHA")
    if sha:
        return sha[:8]
    from flask import current_app
    try:
        return str(int(max(os.path.getmtime(os.path.join(current_app.static_folder, "m", f)) for f in ("app.js", "app.css"))))
    except OSError:
        return "1"


@bp.route("/app")
def app_home():
    """The Samvaad app (phone-style). It handles its own sign-in."""
    cfg = auth.public_config()
    user = auth.current_user()
    cfg.update(user={"email": user.get("email"), "name": user.get("name")} if user else None,
               support_phone="".join(ch for ch in os.getenv("SUPPORT_PHONE", "") if ch.isdigit()) or None)
    resp = make_response(render_template("mobile.html", cfg=cfg, v=_asset_version()))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/classic")
@auth.login_required
def classic_app():
    """The first web version of the customer app."""
    return render_template("app.html", active="app", is_admin=auth.is_admin())


@bp.route("/privacy")
def privacy():
    return render_template("privacy.html", active="privacy")


@bp.route("/manifest.webmanifest")
def manifest():
    from flask import current_app
    return current_app.send_static_file("manifest.webmanifest"), 200, {"Content-Type": "application/manifest+json"}


@bp.route("/sw.js")
def service_worker():
    from flask import current_app
    resp = current_app.send_static_file("js/sw.js")
    resp.headers["Content-Type"] = "application/javascript"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# ------------------------------------------------------------------- auth

@bp.route("/auth/config")
def auth_config():
    return jsonify(auth.public_config())


@bp.route("/auth/session", methods=["POST"])
def auth_session():
    payload = request.get_json(silent=True) or {}
    if limits.too_fast("auth:" + limits.client_ip(request), 20, 600):
        return jsonify({"error": "Too many sign-in attempts. Wait a few minutes and try again."}), 429
    m = auth.mode()
    if m == "off":
        return jsonify({"error": "Sign-in isn't set up on this server yet."}), 503
    if auth.ON_VERCEL and not os.getenv("SECRET_KEY"):
        return jsonify({"error": "SECRET_KEY isn't set on the server, so sign-in can't stay secure."}), 503

    if m == "supabase":
        user = auth.verify_supabase_token(payload.get("access_token"))
        if not user:
            return jsonify({"error": "That sign-in has expired. Please sign in again."}), 401
    else:  # local test mode
        email = (payload.get("email") or "").strip().lower()
        if "@" not in email or len(email) > 120:
            return jsonify({"error": "Enter a valid email address."}), 400
        user = {"id": auth.local_user_id(email), "email": email, "name": (payload.get("name") or "").strip()[:60]}

    store, err = store_or_error()
    if err:
        return err
    existing = store.get_profile(user["id"])
    fields = {"email": user["email"]}
    if user.get("name") and not (existing or {}).get("name"):
        fields["name"] = user["name"]
    store.upsert_profile(user["id"], fields)
    auth.sign_in(user)
    if not auth.is_admin(user):
        log(store, "signed_in" if existing else "signed_up", user["email"], uid=user["id"])
    nxt = payload.get("next") or ""
    return jsonify({"ok": True, "next": nxt if nxt.startswith("/") and not nxt.startswith("//") else "/app"})


@bp.route("/auth/logout", methods=["POST"])
def auth_logout():
    auth.sign_out()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- profile

@bp.route("/api/me")
@auth.login_required
def me():
    store, err = store_or_error()
    if err:
        return err
    return jsonify({
        "user": auth.current_user(),
        "profile": store.get_profile(user_id()) or {},
        "is_admin": auth.is_admin(),
        "ai": advisor.provider_label(),
        "voice": bool(os.getenv("SARVAM_API_KEY")),
        "loan_types": L.LOAN_TYPES,
        "default_foreclosure": L.DEFAULT_FORECLOSURE_PCT,
    })


@bp.route("/api/me", methods=["PUT"])
@auth.login_required
def update_me():
    store, err = store_or_error()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    clean = {}
    for key in ("name", "phone", "employer", "city"):
        if key in data:
            clean[key] = str(data[key] or "").strip()[:80]
    if "salary" in data:
        raw = str(data["salary"] or "").replace(",", "").replace("₹", "").strip()
        if raw:
            try:
                salary = float(raw)
            except ValueError:
                return jsonify({"error": "Salary must be a number, like 75000."}), 400
            if salary <= 0 or salary > 10_000_000:
                return jsonify({"error": "Enter your monthly take-home salary in rupees."}), 400
            clean["salary"] = round(salary, 0)
        else:
            clean["salary"] = None
    before = store.get_profile(user_id()) or {}
    profile = store.upsert_profile(user_id(), clean)
    changed = [k for k in clean if (before.get(k) or None) != (clean[k] or None)]
    if changed:
        labels = {"name": "name", "phone": "phone", "employer": "company", "city": "city", "salary": "salary"}
        log(store, "details", "Changed " + ", ".join(labels.get(k, k) for k in changed),
            {k: clean[k] for k in changed})
    return jsonify({"profile": profile})


# ------------------------------------------------------------------ loans

def _loans_payload(store, uid):
    profile = store.get_profile(uid) or {}
    loans = load_loans(store, uid)
    return {"loans": loans, "overview": L.overview(loans, profile.get("salary")), "profile": profile}


@bp.route("/api/loans")
@auth.login_required
def list_loans():
    store, err = store_or_error()
    if err:
        return err
    return jsonify(_loans_payload(store, user_id()))


@bp.route("/api/loans", methods=["POST"])
@auth.login_required
def add_loan():
    store, err = store_or_error()
    if err:
        return err
    if len(store.list_loans(user_id())) >= 25:
        return jsonify({"error": "You can add up to 25 loans."}), 400
    try:
        loan = L.clean_loan(request.get_json(silent=True) or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    store.add_loan(user_id(), loan)
    log(store, "loan_added", loan_line(loan), {"loan": loan})
    return jsonify(_loans_payload(store, user_id()))


@bp.route("/api/loans/bulk", methods=["POST"])
@auth.login_required
def add_loans_bulk():
    """Loans read from a CIBIL report, checked by the customer."""
    store, err = store_or_error()
    if err:
        return err
    items = (request.get_json(silent=True) or {}).get("loans") or []
    if not isinstance(items, list) or not items:
        return jsonify({"error": "No loans to add."}), 400
    if len(store.list_loans(user_id())) + len(items) > 25:
        return jsonify({"error": "You can add up to 25 loans."}), 400
    cleaned = []
    for i, raw in enumerate(items[:25]):
        try:
            cleaned.append(L.clean_loan({**raw, "source": "cibil"}))
        except ValueError as exc:
            name = L.LOAN_TYPES.get(raw.get("type"), "Loan")
            return jsonify({"error": f"{name} ({raw.get('lender') or 'no lender'}): {exc}", "index": i}), 400
    for loan in cleaned:
        store.add_loan(user_id(), loan)
    log(store, "loan_added", f"{len(cleaned)} loan{'s' if len(cleaned) != 1 else ''} from CIBIL report: " +
        "; ".join(loan_line(l) for l in cleaned)[:280], {"loans": cleaned, "source": "cibil"})
    return jsonify(_loans_payload(store, user_id()))


@bp.route("/api/loans/<loan_id>", methods=["PUT"])
@auth.login_required
def edit_loan(loan_id):
    store, err = store_or_error()
    if err:
        return err
    try:
        loan = L.clean_loan(request.get_json(silent=True) or {})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    store.update_loan(user_id(), loan_id, loan)
    log(store, "loan_updated", loan_line(loan), {"loan": loan})
    return jsonify(_loans_payload(store, user_id()))


@bp.route("/api/loans/<loan_id>", methods=["DELETE"])
@auth.login_required
def remove_loan(loan_id):
    store, err = store_or_error()
    if err:
        return err
    gone = next((l for l in store.list_loans(user_id()) if l["id"] == loan_id), None)
    store.delete_loan(user_id(), loan_id)
    if gone:
        log(store, "loan_removed", loan_line(gone), {"loan": gone})
    return jsonify(_loans_payload(store, user_id()))


# ------------------------------------------------------- plans & savings

@bp.route("/api/plan")
@auth.login_required
def plan():
    store, err = store_or_error()
    if err:
        return err
    loans = load_loans(store, user_id())
    try:
        extra = max(0.0, min(10_000_000.0, float(request.args.get("extra") or 0)))
    except ValueError:
        extra = 0.0
    strategy = "snowball" if request.args.get("strategy") == "snowball" else "avalanche"
    return jsonify({"plan": L.payoff_plan(loans, extra, strategy), "loans": loans})


@bp.route("/api/savings")
@auth.login_required
def savings():
    store, err = store_or_error()
    if err:
        return err
    uid = user_id()
    loans = load_loans(store, uid)
    profile = store.get_profile(uid) or {}
    bank_offers = offers(store)
    new_type = request.args.get("type") or "personal"
    if new_type not in L.LOAN_TYPES:
        new_type = "personal"
    return jsonify({
        "transfers": L.savings_finder(loans, bank_offers),
        "eligibility": L.eligibility(profile.get("salary"), loans, bank_offers, new_type),
        "salary": profile.get("salary"),
        "fresh_types": sorted({o["product"] for o in bank_offers}),
    })


# --------------------------------------------------------------- requests

@bp.route("/api/requests")
@auth.login_required
def my_requests():
    store, err = store_or_error()
    if err:
        return err
    return jsonify({"requests": store.list_requests(user_id()), "kinds": REQUEST_KINDS})


@bp.route("/api/requests", methods=["POST"])
@auth.login_required
def new_request():
    """'Get this done'. The server re-calculates what the customer saw, so the
    request you receive is based on the app's numbers, not the browser's."""
    store, err = store_or_error()
    if err:
        return err
    uid = user_id()
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    if kind not in REQUEST_KINDS:
        return jsonify({"error": "Unknown request type."}), 400
    phone = "".join(ch for ch in str(data.get("phone") or "") if ch.isdigit() or ch == "+")
    if len(phone.lstrip("+")) < 10:
        return jsonify({"error": "Add a phone number so the Samvaad team can call you."}), 400
    if len(store.list_requests(uid)) >= 50:
        return jsonify({"error": "You have too many open requests. The team will get back to you."}), 429
    if limits.over_daily(store, uid, "request"):
        return jsonify({"error": limits.MESSAGES["request"]}), 429

    store.upsert_profile(uid, {"phone": phone})
    profile = store.get_profile(uid) or {}
    loans = load_loans(store, uid)
    bank_offers = offers(store)
    details = {
        "note": str(data.get("note") or "").strip()[:500],
        "loans": loans,
        "overview": {k: v for k, v in L.overview(loans, profile.get("salary")).items() if k != "loans"},
        "salary": profile.get("salary"),
    }
    if kind == "balance_transfer":
        loan = next((l for l in loans if l["id"] == data.get("loan_id")), None)
        if not loan:
            return jsonify({"error": "Pick the loan you want to move."}), 400
        options = L.transfer_options(loan, bank_offers)
        chosen = next((o for o in options if o["bank_id"] == data.get("bank_id")), options[0] if options else None)
        details.update(loan=loan, offer=chosen)
    elif kind == "fresh_loan":
        loan_type = data.get("loan_type") if data.get("loan_type") in L.LOAN_TYPES else "personal"
        details.update(loan_type=loan_type,
                       amount_wanted=data.get("amount"),
                       eligibility=L.eligibility(profile.get("salary"), loans, bank_offers, loan_type))
    elif kind == "payoff_help":
        details.update(plan=L.payoff_plan(loans, float(data.get("extra") or 0)))
    if kind == "callback":
        details.update(call_time=str(data.get("call_time") or "")[:60], topic=str(data.get("topic") or "")[:60])
    req_id = store.create_request(uid, kind, details)
    what = {"balance_transfer": lambda: f"{L.LOAN_TYPES.get(details['loan']['type'])} → {(details.get('offer') or {}).get('bank', 'best offer')}",
            "fresh_loan": lambda: f"{L.LOAN_TYPES.get(details['loan_type'])}, {details.get('amount_wanted') or 'amount not given'}",
            "payoff_help": lambda: f"Extra {L.inr(float(data.get('extra') or 0))} a month",
            "callback": lambda: f"{details.get('call_time') or 'any time'} · {details.get('topic') or ''}".strip(" ·")}
    try:
        line = what[kind]()
    except Exception:
        line = ""
    log(store, "request", f"{REQUEST_KINDS[kind]}: {line} · phone {phone}", {"request_id": req_id, "kind": kind})
    return jsonify({"ok": True, "id": req_id})


# --------------------------------------------------------------- Ask Ritu

@bp.route("/api/ritu", methods=["POST"])
@auth.login_required
def ask_ritu():
    store, err = store_or_error()
    if err:
        return err
    uid = user_id()
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()[:1000]
    if not message:
        return jsonify({"error": "Type or say your question first."}), 400
    if limits.over_daily(store, uid, "ritu"):
        return jsonify({"error": limits.MESSAGES["ritu"]}), 429
    if limits.too_fast("ritu:" + uid, 6, 60):
        return jsonify({"error": "Slow down a little. Ask again in a minute."}), 429
    voice = bool(data.get("voice"))
    log(store, "ritu", message[:300], {"voice": voice})
    try:
        reply, used = advisor.ask(message, data.get("history") or [], store.get_profile(uid),
                                  load_loans(store, uid), offers(store), voice=voice)
    except advisor.AdvisorError as exc:
        return jsonify({"error": str(exc)}), 502
    except Exception:
        return jsonify({"error": "Ritu couldn't answer just now. Try again in a moment."}), 502

    audio = None
    if voice and os.getenv("SARVAM_API_KEY"):
        try:
            from core.respond import pick_language
            from core.speak import speak_bytes
            lang = pick_language(message, None, "en-IN")
            audio = base64.b64encode(speak_bytes(reply, language_code=lang)).decode("ascii")
        except Exception:
            audio = None  # text still works
    return jsonify({"reply": reply, "audio": audio, "provider": used})


@bp.route("/api/ritu/listen", methods=["POST"])
@auth.login_required
def ritu_listen():
    """Voice question -> text (Sarvam speech-to-text)."""
    if not os.getenv("SARVAM_API_KEY"):
        return jsonify({"error": "Voice isn't set up. Type your question instead."}), 503
    if limits.too_fast("listen:" + user_id(), 6, 60):
        return jsonify({"error": "Slow down a little. Try again in a minute."}), 429
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "No audio received."}), 400
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        audio.save(path)
        from core.listen import transcribe
        text, _lang = transcribe(path)
    except Exception:
        return jsonify({"error": "Couldn't hear that. Try again or type instead."}), 502
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return jsonify({"text": (text or "").strip()})


# ------------------------------------------------------------ app home

@bp.route("/api/home")
@auth.login_required
def home_data():
    """Everything the app's home screen needs, in one call."""
    store, err = store_or_error()
    if err:
        return err
    uid = user_id()
    profile = store.get_profile(uid) or {}
    loans = load_loans(store, uid)
    bank_offers = offers(store)
    plans = {}
    if loans:
        for extra in (2000, 5000, 10000):
            plans[str(extra)] = L.payoff_plan(loans, extra, "avalanche")
    products = sorted({o["product"] for o in bank_offers})
    elig = {t: L.eligibility(profile.get("salary"), loans, bank_offers, t) for t in products} if profile.get("salary") else {}
    from core import report
    return jsonify({
        "user": auth.current_user(),
        "profile": profile,
        "overview": L.overview(loans, profile.get("salary")),
        "transfers": L.savings_finder(loans, bank_offers),
        "plans": plans,
        "eligibility": elig,
        "requests": store.list_requests(uid),
        "loan_types": L.LOAN_TYPES,
        "kinds": REQUEST_KINDS,
        "report_reader": report.enabled(),
        "is_admin": auth.is_admin(),
        "voice": bool(os.getenv("SARVAM_API_KEY")),
    })


# ---------------------------------------------------------------- CIBIL

@bp.route("/api/cibil", methods=["PUT"])
@auth.login_required
def save_score():
    store, err = store_or_error()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    try:
        score = int(str(data.get("score") or "").strip())
    except ValueError:
        score = 0
    if not 300 <= score <= 900:
        return jsonify({"error": "A CIBIL score is between 300 and 900."}), 400
    from datetime import date
    profile = store.upsert_profile(user_id(), {"cibil_score": score, "cibil_date": date.today().isoformat()})
    log(store, "cibil_score", f"Score {score} (typed in)", {"score": score})
    return jsonify({"profile": profile})


@bp.route("/api/cibil/report", methods=["POST"])
@auth.login_required
def upload_report():
    """Customer uploads the CIBIL PDF. We keep it privately for the team and,
    when the report reader is on, return the score and open loans to check."""
    store, err = store_or_error()
    if err:
        return err
    from core import report
    if limits.over_daily(store, user_id(), "cibil_report") or limits.too_fast("report:" + user_id(), 10, 600):
        return jsonify({"error": limits.MESSAGES["cibil_report"]}), 429
    f = request.files.get("report")
    if not f:
        return jsonify({"error": "Choose the PDF report from CIBIL."}), 400
    data = f.read(report.MAX_BYTES + 1)
    if len(data) > report.MAX_BYTES:
        return jsonify({"error": "That file is over 4 MB. Download the report again from CIBIL as a PDF."}), 400
    if not data.startswith(b"%PDF"):
        return jsonify({"error": "That file isn't a PDF. Choose the report PDF from CIBIL."}), 400
    password = (request.form.get("password") or "").strip()[:40] or None
    try:
        readable = report.unlock(data, password)
    except report.ReportError as exc:
        code = str(exc)
        if code == "PASSWORD_NEEDED":
            return jsonify({"error": "This report is password-protected. Enter its password.", "needs_password": True}), 400
        if code == "WRONG_PASSWORD":
            return jsonify({"error": "That password didn't open the report. Try again.", "needs_password": True}), 400
        return jsonify({"error": code}), 400

    uid = user_id()
    old = (store.get_profile(uid) or {}).get("cibil_report")
    try:
        path = store.save_report(uid, readable)
    except Exception:
        return jsonify({"error": "Couldn't save the report. Try again in a minute."}), 502
    store.upsert_profile(uid, {"cibil_report": path, "cibil_report_at": store_now()})
    if old and old != path:  # keep only the latest report
        try:
            store.delete_report(old)
        except Exception:
            pass

    result, problem = None, None
    if report.enabled():
        try:
            result = report.read(readable)
        except report.ReportError as exc:
            problem = str(exc)
    else:
        problem = "Your report is saved and our executive will go through it. You can type your score now."

    if result and result.get("score"):
        from datetime import date
        store.upsert_profile(uid, {"cibil_score": result["score"],
                                   "cibil_date": result.get("report_date") or date.today().isoformat()})
    n = len((result or {}).get("accounts") or [])
    log(store, "cibil_report",
        (f"Score {result['score']} · " if result and result.get("score") else "") +
        (f"{n} open account{'s' if n != 1 else ''} found" if result else "Report saved, not read automatically"),
        {"path": path, "score": (result or {}).get("score"), "accounts": (result or {}).get("accounts")})
    return jsonify({"saved": True, "result": result, "message": problem})
