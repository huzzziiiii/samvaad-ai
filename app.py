"""Credwise: the phone app (/app), its API and admin mode. Nothing else."""
import os
from datetime import timedelta

from flask import Flask, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

from core import auth
import customer
import admin

# Static files live in public/static: Vercel serves public/ from its CDN at the
# same /static/... URLs, and Flask serves them the same way locally.
app = Flask(__name__, static_folder="public/static", static_url_path="/static")

app.secret_key = auth.secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=auth.ON_VERCEL or bool(os.getenv("SECURE_COOKIES")),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
)
app.register_blueprint(customer.bp)
app.register_blueprint(admin.bp)


@app.route("/")
def landing():
    """There is no website: every visit opens the app."""
    return redirect(url_for("customer.app_home"))


if __name__ == "__main__":
    app.run(debug=True, port=int(os.getenv("PORT", "5000")))
