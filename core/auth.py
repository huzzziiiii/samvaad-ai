"""Sign-in for Samvaad.

Modes
- "supabase": real accounts. The browser signs in with Supabase (email +
  password, or Google if you switch it on), then sends us its access token.
  We confirm the token with Supabase and keep the user in a signed Flask
  session cookie.
- "local": only on your own computer when Supabase isn't set up. You type an
  email and you're in, so you can test without any accounts. Never used on
  Vercel.
- "off": on Vercel without Supabase. Sign-in is disabled with a clear message.
"""
import os
import secrets
from functools import wraps

import requests
from flask import session, request, redirect, url_for, jsonify

from core.paths import ON_VERCEL, WRITE_DATA


def mode():
    if os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_ANON_KEY"):
        return "supabase"
    if not ON_VERCEL:
        return "local"
    return "off"


def public_config():
    """Safe to send to the browser (the anon key is public by design)."""
    return {
        "mode": mode(),
        "supabase_url": os.getenv("SUPABASE_URL", "") if mode() == "supabase" else "",
        "supabase_anon_key": os.getenv("SUPABASE_ANON_KEY", "") if mode() == "supabase" else "",
        "google": os.getenv("SUPABASE_GOOGLE_LOGIN") == "1",
    }


def secret_key():
    """Flask needs a secret to sign the session cookie. Set SECRET_KEY in
    production; locally we create one in data/ so sessions survive restarts."""
    key = os.getenv("SECRET_KEY")
    if key:
        return key
    if ON_VERCEL:
        # Sessions would break across instances; sign-in refuses to work below.
        return secrets.token_hex(32)
    path = os.path.join(WRITE_DATA, ".secret_key")
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        os.makedirs(WRITE_DATA, exist_ok=True)
        key = secrets.token_hex(32)
        with open(path, "w") as f:
            f.write(key)
        return key


def verify_supabase_token(token):
    """Ask Supabase who this access token belongs to. Returns a user dict or None."""
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    anon = os.getenv("SUPABASE_ANON_KEY", "")
    if not (url and anon and token):
        return None
    try:
        r = requests.get(f"{url}/auth/v1/user", headers={"apikey": anon, "Authorization": f"Bearer {token}"}, timeout=10)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    data = r.json()
    meta = data.get("user_metadata") or {}
    return {
        "id": data["id"],
        "email": (data.get("email") or "").lower(),
        "name": meta.get("full_name") or meta.get("name") or "",
    }


def admin_emails():
    return {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}


def is_admin(user=None):
    user = user or current_user()
    if not user:
        return False
    admins = admin_emails()
    if not admins:
        # Locally, with no ADMIN_EMAILS set, whoever signs in can open the
        # admin panel so you can test it. In production you must list admins.
        return mode() == "local"
    return user.get("email", "").lower() in admins


def sign_in(user):
    session.clear()
    session["user"] = {"id": user["id"], "email": user.get("email", ""), "name": user.get("name", "")}
    session.permanent = True


def sign_out():
    session.clear()


def current_user():
    return session.get("user")


def local_user_id(email):
    """Stable id for local test mode, derived from the email."""
    import hashlib
    return "local_" + hashlib.sha256(email.lower().encode()).hexdigest()[:20]


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({"error": "Please sign in again."}), 401
            return redirect(url_for("customer.login", next=request.path))
        return view(*args, **kwargs)
    return wrapper


def admin_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Please sign in again."}), 401
            return redirect(url_for("customer.login", next=request.path))
        if not is_admin(user):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Admins only."}), 403
            return redirect(url_for("customer.app_home"))
        return view(*args, **kwargs)
    return wrapper
