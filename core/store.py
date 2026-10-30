"""Where Samvaad keeps customers, loans, requests and the bank rate table.

Two backends with the same methods:
- SupabaseStore: production. Talks to Supabase's REST API with the service
  role key (server side only). Tables come from supabase/schema.sql.
- SQLiteStore: local testing on your laptop, in data/samvaad.db.

get_store() picks Supabase when SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
"""
import os
import json
import uuid
import sqlite3
import threading
from datetime import datetime, timezone

import requests

from core.paths import WRITE_DATA, ON_VERCEL

REQUEST_KINDS = {
    "balance_transfer": "Balance transfer",
    "fresh_loan": "Fresh loan",
    "payoff_help": "Help with my payoff plan",
    "callback": "Call me back",
}
REQUEST_STATUSES = ["new", "contacted", "in_progress", "done", "closed"]

PROFILE_FIELDS = ("name", "email", "phone", "salary", "employer", "city",
                  "cibil_score", "cibil_date", "cibil_report", "last_seen")
LOAN_FIELDS = ("type", "lender", "outstanding", "rate", "emi", "months_left", "foreclosure_pct", "source")

# What customers did, as shown in the admin activity feed.
EVENT_KINDS = {
    "signed_up": "Signed up",
    "signed_in": "Signed in",
    "details": "Updated details",
    "loan_added": "Added a loan",
    "loan_updated": "Edited a loan",
    "loan_removed": "Removed a loan",
    "cibil_score": "Added CIBIL score",
    "cibil_report": "Uploaded CIBIL report",
    "ritu": "Asked Ritu",
    "request": "Sent a request",
}
BANK_FIELDS = ("name", "product", "rate_min", "rate_max", "processing_fee_pct", "max_tenure_months", "active", "notes")

# Placeholder offers so the app works on day one. They are deliberately not
# real bank names: replace them in the admin panel with the banks you're
# empanelled with and their current rate cards.
SAMPLE_BANKS = [
    ("Sample Bank A", "personal", 10.5, 14.0, 1.0, 72),
    ("Sample Bank B", "personal", 11.25, 16.0, 1.5, 60),
    ("Sample Bank A", "home", 8.35, 9.25, 0.5, 360),
    ("Sample NBFC C", "home", 8.9, 10.5, 0.5, 300),
    ("Sample Bank B", "car", 8.75, 10.5, 1.0, 84),
    ("Sample NBFC C", "credit_card", 12.0, 16.0, 2.0, 48),
    ("Sample Bank A", "business", 13.0, 18.0, 2.0, 60),
]


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id():
    return uuid.uuid4().hex


def _attach_people(rows, people):
    for r in rows:
        p = people.get(r["user_id"], {})
        r.update(customer_name=p.get("name"), customer_email=p.get("email"), customer_phone=p.get("phone"),
                 label=EVENT_KINDS.get(r.get("kind"), r.get("kind")))
    return rows


def _pick(data, fields):
    return {k: data[k] for k in fields if k in data}


# ------------------------------------------------------------------ SQLite

class SQLiteStore:
    backend = "sqlite"

    SCHEMA = """
    create table if not exists profiles (
        user_id text primary key, name text, email text, phone text,
        salary real, employer text, city text, created_at text, updated_at text);
    create table if not exists loans (
        id text primary key, user_id text not null, type text, lender text,
        outstanding real, rate real, emi real, months_left integer,
        foreclosure_pct real, created_at text, updated_at text);
    create index if not exists loans_user on loans(user_id);
    create table if not exists requests (
        id text primary key, user_id text not null, kind text, details text,
        status text, admin_note text, created_at text, updated_at text);
    create index if not exists requests_user on requests(user_id);
    create table if not exists events (
        id text primary key, user_id text not null, kind text, summary text,
        details text, created_at text);
    create index if not exists events_created on events(created_at);
    create index if not exists events_user on events(user_id, created_at);
    create table if not exists banks (
        id text primary key, name text, product text, rate_min real, rate_max real,
        processing_fee_pct real, max_tenure_months integer, active integer,
        notes text, updated_at text);
    """

    def __init__(self, path=None):
        self.path = path or os.path.join(WRITE_DATA, "samvaad.db")
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(self.SCHEMA)
            # older local databases: add the newer columns
            for table, col, kind in (("profiles", "cibil_score", "integer"), ("profiles", "cibil_date", "text"),
                                     ("profiles", "cibil_report", "text"), ("profiles", "last_seen", "text"),
                                     ("loans", "source", "text")):
                if col not in [r[1] for r in c.execute(f"pragma table_info({table})")]:
                    c.execute(f"alter table {table} add column {col} {kind}")
            if not c.execute("select 1 from banks limit 1").fetchone():
                for name, product, lo, hi, fee, tenure in SAMPLE_BANKS:
                    c.execute("insert into banks values (?,?,?,?,?,?,?,?,?,?)",
                              (new_id(), name, product, lo, hi, fee, tenure, 1, "Sample rates — replace", now()))

    def _conn(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def _rows(self, sql, args=()):
        with self._lock, self._conn() as c:
            return [dict(r) for r in c.execute(sql, args).fetchall()]

    def _exec(self, sql, args=()):
        with self._lock, self._conn() as c:
            c.execute(sql, args)

    # profiles
    def get_profile(self, user_id):
        rows = self._rows("select * from profiles where user_id=?", (user_id,))
        return rows[0] if rows else None

    def upsert_profile(self, user_id, data):
        data = _pick(data, PROFILE_FIELDS)
        existing = self.get_profile(user_id)
        if existing:
            if data:
                sets = ", ".join(f"{k}=?" for k in data)
                self._exec(f"update profiles set {sets}, updated_at=? where user_id=?",
                           (*data.values(), now(), user_id))
        else:
            cols = ["user_id", *PROFILE_FIELDS, "created_at", "updated_at"]
            vals = [user_id, *[data.get(k) for k in PROFILE_FIELDS], now(), now()]
            self._exec(f"insert into profiles ({','.join(cols)}) values ({','.join('?' * len(cols))})", vals)
        return self.get_profile(user_id)

    # loans
    def list_loans(self, user_id):
        return self._rows("select * from loans where user_id=? order by created_at", (user_id,))

    def add_loan(self, user_id, loan):
        loan_id = new_id()
        cols = ["id", "user_id", *LOAN_FIELDS, "created_at", "updated_at"]
        vals = [loan_id, user_id, *[loan.get(k) for k in LOAN_FIELDS], now(), now()]
        vals[cols.index("source")] = loan.get("source") or "typed"
        self._exec(f"insert into loans ({','.join(cols)}) values ({','.join('?' * len(cols))})", vals)
        return loan_id

    def update_loan(self, user_id, loan_id, loan):
        data = _pick(loan, LOAN_FIELDS)
        sets = ", ".join(f"{k}=?" for k in data)
        self._exec(f"update loans set {sets}, updated_at=? where id=? and user_id=?",
                   (*data.values(), now(), loan_id, user_id))

    def delete_loan(self, user_id, loan_id):
        self._exec("delete from loans where id=? and user_id=?", (loan_id, user_id))

    # requests
    def create_request(self, user_id, kind, details):
        req_id = new_id()
        self._exec("insert into requests values (?,?,?,?,?,?,?,?)",
                   (req_id, user_id, kind, json.dumps(details, ensure_ascii=False), "new", "", now(), now()))
        return req_id

    def _decode(self, rows):
        for r in rows:
            try:
                r["details"] = json.loads(r.get("details") or "{}")
            except ValueError:
                r["details"] = {}
        return rows

    def list_requests(self, user_id):
        return self._decode(self._rows("select * from requests where user_id=? order by created_at desc", (user_id,)))

    def admin_list_requests(self):
        rows = self._rows("""select r.*, p.name as customer_name, p.email as customer_email,
                             p.phone as customer_phone, p.employer as customer_employer
                             from requests r left join profiles p on p.user_id = r.user_id
                             order by r.created_at desc""")
        return self._decode(rows)

    def admin_update_request(self, req_id, status=None, note=None):
        if status:
            self._exec("update requests set status=?, updated_at=? where id=?", (status, now(), req_id))
        if note is not None:
            self._exec("update requests set admin_note=?, updated_at=? where id=?", (note, now(), req_id))

    def admin_counts(self):
        rows = self._rows("select (select count(*) from profiles) as customers, "
                          "(select count(*) from loans) as loans, "
                          "(select count(*) from requests where status='new') as new_requests")
        return rows[0]

    # export (admin)
    def admin_all_profiles(self):
        return self._rows("select * from profiles order by created_at")

    def admin_all_loans(self):
        return self._rows("select * from loans order by created_at")

    def admin_all_requests(self):
        return self._decode(self._rows("select * from requests order by created_at desc"))

    # activity log
    def log_event(self, user_id, kind, summary="", details=None):
        self._exec("insert into events (id, user_id, kind, summary, details, created_at) values (?,?,?,?,?,?)",
                   (new_id(), user_id, kind, summary[:300], json.dumps(details or {}, ensure_ascii=False), now()))
        self._exec("update profiles set last_seen=? where user_id=?", (now(), user_id))

    def admin_events(self, limit=100, user_id=None, before=None):
        sql, args = "select * from events where 1=1", []
        if user_id:
            sql += " and user_id=?"; args.append(user_id)
        if before:
            sql += " and created_at<?"; args.append(before)
        rows = self._rows(sql + " order by created_at desc limit ?", (*args, int(limit)))
        return _attach_people(self._decode(rows), {p["user_id"]: p for p in self.admin_all_profiles()})

    def admin_customer(self, user_id):
        p = self.get_profile(user_id)
        if not p:
            return None
        return {"profile": p, "loans": self.list_loans(user_id), "requests": self.list_requests(user_id),
                "events": self.admin_events(200, user_id)}

    # CIBIL reports (local: saved under data/reports)
    def save_report(self, user_id, data):
        folder = os.path.join(WRITE_DATA, "reports")
        os.makedirs(folder, exist_ok=True)
        name = f"{user_id}/{new_id()}.pdf"
        os.makedirs(os.path.join(folder, user_id), exist_ok=True)
        with open(os.path.join(folder, name), "wb") as f:
            f.write(data)
        return name

    def read_report(self, path):
        with open(os.path.join(WRITE_DATA, "reports", path), "rb") as f:
            return f.read()

    # banks
    def list_banks(self, active_only=False):
        sql = "select * from banks" + (" where active=1" if active_only else "") + " order by product, rate_min"
        rows = self._rows(sql)
        for r in rows:
            r["active"] = bool(r["active"])
        return rows

    def upsert_bank(self, bank, bank_id=None):
        data = _pick(bank, BANK_FIELDS)
        if "active" in data:
            data["active"] = 1 if data["active"] else 0
        if bank_id:
            sets = ", ".join(f"{k}=?" for k in data)
            self._exec(f"update banks set {sets}, updated_at=? where id=?", (*data.values(), now(), bank_id))
            return bank_id
        bank_id = new_id()
        row = {k: data.get(k) for k in BANK_FIELDS}
        row["active"] = 1 if row.get("active", True) in (None, True, 1) else 0
        self._exec("insert into banks values (?,?,?,?,?,?,?,?,?,?)", (bank_id, *row.values(), now()))
        return bank_id

    def delete_bank(self, bank_id):
        self._exec("delete from banks where id=?", (bank_id,))


# ---------------------------------------------------------------- Supabase

class SupabaseError(RuntimeError):
    pass


class SupabaseStore:
    """Same methods as SQLiteStore, over Supabase's PostgREST API.
    Uses the service role key, so it must only ever run on the server."""
    backend = "supabase"

    def __init__(self, url, service_key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": service_key, "Content-Type": "application/json"}
        # Legacy service_role keys are JWTs and also go in Authorization.
        # New secret keys (sb_secret_...) must only be sent as apikey.
        if service_key.startswith("eyJ"):
            self.headers["Authorization"] = f"Bearer {service_key}"

    def _req(self, method, table, params=None, body=None, prefer=None):
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        r = requests.request(method, f"{self.base}/{table}", params=params, json=body, headers=headers, timeout=15)
        if r.status_code >= 400:
            raise SupabaseError(f"Supabase {method} {table} failed ({r.status_code}): {r.text[:200]}")
        return r.json() if r.text else None

    # profiles
    def get_profile(self, user_id):
        rows = self._req("GET", "profiles", {"user_id": f"eq.{user_id}", "select": "*"})
        return rows[0] if rows else None

    def upsert_profile(self, user_id, data):
        body = {"user_id": user_id, **_pick(data, PROFILE_FIELDS), "updated_at": now()}
        rows = self._req("POST", "profiles", {"on_conflict": "user_id"}, body,
                         prefer="resolution=merge-duplicates,return=representation")
        return rows[0] if rows else self.get_profile(user_id)

    # loans
    def list_loans(self, user_id):
        return self._req("GET", "loans", {"user_id": f"eq.{user_id}", "select": "*", "order": "created_at"})

    def add_loan(self, user_id, loan):
        loan_id = new_id()
        self._req("POST", "loans", body={"id": loan_id, "user_id": user_id, **_pick(loan, LOAN_FIELDS)})
        return loan_id

    def update_loan(self, user_id, loan_id, loan):
        self._req("PATCH", "loans", {"id": f"eq.{loan_id}", "user_id": f"eq.{user_id}"},
                  {**_pick(loan, LOAN_FIELDS), "updated_at": now()})

    def delete_loan(self, user_id, loan_id):
        self._req("DELETE", "loans", {"id": f"eq.{loan_id}", "user_id": f"eq.{user_id}"})

    # requests
    def create_request(self, user_id, kind, details):
        req_id = new_id()
        self._req("POST", "requests", body={"id": req_id, "user_id": user_id, "kind": kind,
                                            "details": details, "status": "new", "admin_note": ""})
        return req_id

    def list_requests(self, user_id):
        return self._req("GET", "requests", {"user_id": f"eq.{user_id}", "select": "*", "order": "created_at.desc"})

    def admin_list_requests(self):
        rows = self._req("GET", "requests", {"select": "*", "order": "created_at.desc", "limit": "500"})
        ids = sorted({r["user_id"] for r in rows})
        profiles = {}
        if ids:
            for p in self._req("GET", "profiles", {"user_id": f"in.({','.join(ids)})", "select": "*"}):
                profiles[p["user_id"]] = p
        for r in rows:
            p = profiles.get(r["user_id"], {})
            r.update(customer_name=p.get("name"), customer_email=p.get("email"),
                     customer_phone=p.get("phone"), customer_employer=p.get("employer"))
        return rows

    def admin_update_request(self, req_id, status=None, note=None):
        body = {"updated_at": now()}
        if status:
            body["status"] = status
        if note is not None:
            body["admin_note"] = note
        self._req("PATCH", "requests", {"id": f"eq.{req_id}"}, body)

    def _count(self, table, params=None):
        headers = dict(self.headers, Prefer="count=exact")
        r = requests.head(f"{self.base}/{table}", params={"select": "*", **(params or {})}, headers=headers, timeout=15)
        rng = r.headers.get("Content-Range", "*/0")
        return int(rng.split("/")[-1] or 0) if "/" in rng else 0

    def admin_counts(self):
        return {"customers": self._count("profiles"), "loans": self._count("loans"),
                "new_requests": self._count("requests", {"status": "eq.new"})}

    # export (admin)
    def _all(self, table, order):
        rows, start, step = [], 0, 1000
        while True:
            headers = dict(self.headers, Range=f"{start}-{start + step - 1}")
            r = requests.get(f"{self.base}/{table}", params={"select": "*", "order": order},
                             headers=headers, timeout=30)
            if r.status_code >= 400:
                raise SupabaseError(f"Supabase GET {table} failed ({r.status_code}): {r.text[:200]}")
            page = r.json()
            rows.extend(page)
            if len(page) < step:
                return rows
            start += step

    def admin_all_profiles(self):
        return self._all("profiles", "created_at")

    def admin_all_loans(self):
        return self._all("loans", "created_at")

    def admin_all_requests(self):
        return self._all("requests", "created_at.desc")

    # activity log
    def log_event(self, user_id, kind, summary="", details=None):
        self._req("POST", "events", body={"id": new_id(), "user_id": user_id, "kind": kind,
                                          "summary": summary[:300], "details": details or {}})
        self._req("PATCH", "profiles", {"user_id": f"eq.{user_id}"}, {"last_seen": now()})

    def admin_events(self, limit=100, user_id=None, before=None):
        params = {"select": "*", "order": "created_at.desc", "limit": str(int(limit))}
        if user_id:
            params["user_id"] = f"eq.{user_id}"
        if before:
            params["created_at"] = f"lt.{before}"
        rows = self._req("GET", "events", params)
        ids = sorted({r["user_id"] for r in rows})
        people = {}
        if ids:
            for p in self._req("GET", "profiles", {"user_id": f"in.({','.join(ids)})", "select": "user_id,name,email,phone"}):
                people[p["user_id"]] = p
        return _attach_people(rows, people)

    def admin_customer(self, user_id):
        p = self.get_profile(user_id)
        if not p:
            return None
        return {"profile": p, "loans": self.list_loans(user_id), "requests": self.list_requests(user_id),
                "events": self.admin_events(200, user_id)}

    # CIBIL reports (Supabase Storage, private bucket "reports")
    def _storage(self):
        return self.base.replace("/rest/v1", "/storage/v1")

    def save_report(self, user_id, data):
        path = f"{user_id}/{new_id()}.pdf"
        headers = {k: v for k, v in self.headers.items() if k != "Content-Type"}
        headers["Content-Type"] = "application/pdf"
        r = requests.post(f"{self._storage()}/object/reports/{path}", data=data, headers=headers, timeout=30)
        if r.status_code >= 400:
            raise SupabaseError(f"Report upload failed ({r.status_code}): {r.text[:200]}")
        return path

    def read_report(self, path):
        headers = {k: v for k, v in self.headers.items() if k != "Content-Type"}
        r = requests.get(f"{self._storage()}/object/reports/{path}", headers=headers, timeout=30)
        if r.status_code >= 400:
            raise SupabaseError(f"Report download failed ({r.status_code})")
        return r.content

    # banks
    def list_banks(self, active_only=False):
        params = {"select": "*", "order": "product,rate_min"}
        if active_only:
            params["active"] = "eq.true"
        return self._req("GET", "banks", params)

    def upsert_bank(self, bank, bank_id=None):
        data = _pick(bank, BANK_FIELDS)
        if bank_id:
            self._req("PATCH", "banks", {"id": f"eq.{bank_id}"}, {**data, "updated_at": now()})
            return bank_id
        bank_id = new_id()
        data.setdefault("active", True)
        self._req("POST", "banks", body={"id": bank_id, **data})
        return bank_id

    def delete_bank(self, bank_id):
        self._req("DELETE", "banks", {"id": f"eq.{bank_id}"})


# ------------------------------------------------------------------ choose

_store = None


def supabase_configured():
    return bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_KEY"))


def get_store():
    """Supabase when configured; local SQLite otherwise (not on Vercel, whose
    disk is wiped between requests). Returns None when no store is usable."""
    global _store
    if _store is not None:
        return _store
    if supabase_configured():
        _store = SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    elif not ON_VERCEL:
        _store = SQLiteStore()
    return _store
