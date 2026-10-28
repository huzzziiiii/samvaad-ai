"""The Samvaad customer app: sign-in, loans, plans, savings, Ask Ritu, requests."""
import base64
import os
import tempfile

from flask import Blueprint, render_template, request, jsonify, redirect, url_for

from core import auth
from core import loans as L
from core import advisor
from core.store import get_store, REQUEST_KINDS

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


# ------------------------------------------------------------------ pages

@bp.route("/login")
def login():
    if auth.current_user():
        return redirect(request.args.get("next") or url_for("customer.app_home"))
    return render_template("login.html", active="login", config=auth.public_config(),
                           next=request.args.get("next", ""))


@bp.route("/app")
@auth.login_required
def app_home():
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
    return jsonify({"profile": store.upsert_profile(user_id(), clean)})


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
    return jsonify(_loans_payload(store, user_id()))


@bp.route("/api/loans/<loan_id>", methods=["DELETE"])
@auth.login_required
def remove_loan(loan_id):
    store, err = store_or_error()
    if err:
        return err
    store.delete_loan(user_id(), loan_id)
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
    req_id = store.create_request(uid, kind, details)
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
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"error": "Type or say your question first."}), 400
    voice = bool(data.get("voice"))
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
