"""Ritu, the loan advisor inside the Credwise app.

Which AI answers is one setting (AI_PROVIDER):
  gemini  -> Google Gemini (GEMINI_API_KEY, model GEMINI_MODEL)
  claude  -> Anthropic Claude (ANTHROPIC_API_KEY, model CLAUDE_MODEL)
  sarvam  -> Sarvam sarvam-105b (SARVAM_API_KEY)
  auto    -> the first one that has a key, in that order (default)
With no key at all Ritu still answers from the calculated numbers.

Two rules keep this trustworthy:
1. The AI never calculates. It gets the results of core/loans.py and may
   only quote those numbers.
2. The AI never sees who the customer is: no name, email, phone, employer
   or account numbers. Only loan types, lenders, amounts and rates.
"""
import os
import json
import re

import requests

from core import loans as L


def pct(x):
    """14.0 -> '14%', 9.5 -> '9.5%'"""
    return f"{float(x):g}%"

TIMEOUT = 20  # a slow AI falls back to the app's own answer instead of leaving the customer waiting

SYSTEM_PROMPT = """You are Ritu, the loan advisor inside Credwise, an app that helps salaried employees in India
take control of their loans: close them faster, cut their interest, move loans to cheaper lenders
(balance transfer), and take fresh loans sensibly.

HOW YOU WORK
- You are given the customer's loans and numbers CALCULATED BY THE APP. Only quote numbers that appear in
  that data. Never do your own arithmetic, never estimate, never round differently, never invent a rate,
  bank, offer, fee or approval chance. If a number isn't in the data, say the app can work it out and
  point them to the right tab (Overview, Loans, Savings).
- Rates and offers in the data are indicative. Say the final rate depends on the bank's check of their
  profile and credit score.
- Be practical and specific to THEIR loans. Lead with the single most useful thing.
- Keep replies short: 2 to 5 sentences, or a few short lines. Plain text, no markdown headings or tables.
- When a balance transfer, fresh loan or payoff help would genuinely help, tell them they can tap
  "Get this done" and the Credwise team will handle the bank paperwork for them, free of charge.
  Never pressure them. If switching doesn't save money, say so plainly.
- Never ask for or repeat account numbers, card numbers, PAN, Aadhaar, OTPs or passwords. If they share
  one, tell them not to, and continue without it.
- Don't promise approvals. Don't give tax, legal or investment advice beyond general pointers; suggest a
  CA for tax questions.
- Stay on loans and money matters. If they go off-topic, answer in one kind line and steer back.

LANGUAGE
- Reply in the language of the customer's latest message. Default is clear, warm British English.
- If they write in Hindi or Hinglish, reply in the same style (Hinglish in Latin script if they used it).
"""

VOICE_NOTE = ("\nThis reply will be read aloud. Write every amount and number in words "
              "(for example \"three lakh rupees\", \"fourteen percent\"), and don't use symbols.")


# ------------------------------------------------------------- providers

def provider():
    choice = (os.getenv("AI_PROVIDER") or "auto").lower()
    keys = {
        "gemini": os.getenv("GEMINI_API_KEY"),
        "claude": os.getenv("ANTHROPIC_API_KEY"),
        "sarvam": os.getenv("SARVAM_API_KEY"),
    }
    if choice in keys:
        return choice if keys[choice] else "none"
    for name in ("gemini", "claude", "sarvam"):
        if keys[name]:
            return name
    return "none"


def provider_label():
    p = provider()
    return {
        "gemini": f"Gemini ({os.getenv('GEMINI_MODEL') or 'gemini-3.8-flash'})",
        "claude": f"Claude ({os.getenv('CLAUDE_MODEL') or 'claude-sonnet-5-5'})",
        "sarvam": "Sarvam (sarvam-105b)",
        "none": "No AI key set (answers from the app's numbers only)",
    }[p]


class AdvisorError(RuntimeError):
    pass


def _api_message(r):
    """The provider's own error text (never contains the key), for the admin AI check."""
    try:
        d = r.json()
        err = d.get("error") or {}
        return str(err.get("message") if isinstance(err, dict) else err or d)[:240]
    except Exception:
        return r.text[:240]


GEMINI_FALLBACKS = ("gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite")


def _gemini(system, history, message):
    """Ask Gemini. If a model is overloaded (503/500/429), try the next stable one."""
    first = os.getenv("GEMINI_MODEL") or GEMINI_FALLBACKS[0]
    models = [first] + [m for m in GEMINI_FALLBACKS if m != first]
    while history and history[0]["role"] == "assistant":  # Gemini wants the user to speak first
        history = history[1:]
    contents = [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                for m in history]
    contents.append({"role": "user", "parts": [{"text": message}]})
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 700},
    }
    errors = []
    for model in models:
        try:
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"},
                json=body, timeout=12,
            )
        except requests.RequestException as exc:
            errors.append(f"{model}: {type(exc).__name__}")
            continue
        if r.status_code in (429, 500, 502, 503, 504, 404):
            errors.append(f"{model}: {r.status_code} {_api_message(r)[:90]}")
            continue  # busy or not available: try the next model
        if r.status_code >= 400:
            raise AdvisorError(f"Gemini returned an error ({r.status_code}): {_api_message(r)}")
        data = r.json()
        try:
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts).strip()
        except (KeyError, IndexError):
            errors.append(f"{model}: no answer")
            continue
        if text:
            return text
    raise AdvisorError("All Gemini models were busy: " + " | ".join(errors))


def _claude(system, history, message):
    model = os.getenv("CLAUDE_MODEL") or "claude-sonnet-5-5"
    msgs = [{"role": m["role"], "content": m["content"]} for m in history]
    msgs.append({"role": "user", "content": message})
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": model, "max_tokens": 700, "temperature": 0.4,
              "system": [{"type": "text", "text": system}], "messages": msgs},
        timeout=TIMEOUT,
    )
    if r.status_code == 429:
        raise AdvisorError("Ritu is busy right now. Try again in a minute.")
    if r.status_code >= 400:
        raise AdvisorError(f"Claude returned an error ({r.status_code}): {_api_message(r)}")
    data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()


def _sarvam(system, history, message):
    from core.respond import client  # reuses the existing Sarvam client
    msgs = [{"role": "system", "content": system}] + list(history) + [{"role": "user", "content": message}]
    response = client.chat.completions(model="sarvam-105b", messages=msgs)
    return (response.choices[0].message.content or "").strip()


# --------------------------------------------------------------- context

def build_context(profile, loans, offers):
    """Everything Ritu may talk about, already calculated. No personal identifiers."""
    salary = (profile or {}).get("salary")
    ov = L.overview(loans, salary)
    plan_now = L.payoff_plan(loans, 0) if loans else None
    plans = {}
    for extra in (2000, 5000, 10000):
        if loans:
            p = L.payoff_plan(loans, extra, "avalanche")
            plans[f"pay_{extra}_extra_per_month"] = {
                "debt_free_in": L.months_text(p["plan_months"]),
                "months_saved": p["months_saved"],
                "interest_saved": L.inr(p["interest_saved"]),
                "close_in_this_order": [f"{L.LOAN_TYPES[o['type']]} ({o['lender'] or 'lender not given'}, {pct(o['rate'])})"
                                        for o in p["order"]],
            }
    savings = []
    for item in L.savings_finder(loans, offers):
        loan = item["loan"]
        label = f"{L.LOAN_TYPES[loan['type']]} with {loan['lender'] or 'current lender'} at {pct(loan['rate'])}"
        if not item["options"]:
            savings.append({"loan": label, "balance_transfer": "No cheaper offer that saves money after fees."})
            continue
        best = item["options"][0]
        savings.append({
            "loan": label,
            "best_offer": best["bank"],
            "rate_from": pct(best['best']['rate']),
            "net_saving_range": f"{L.inr(best['cautious']['net_saving'])} to {L.inr(best['best']['net_saving'])}",
            "new_emi_from": L.inr(best["best"]["new_emi"]),
            "fees_counted": f"processing {L.inr(best['processing_fee'])}, foreclosure {L.inr(best['foreclosure_charge'])}",
        })
    elig = L.eligibility(salary, loans, offers, "personal") if salary else None
    banks = L.best_banks(loans, offers, profile or {})

    return {
        "monthly_take_home_salary": L.inr(salary) if salary else "not given",
        "cibil_score": (profile or {}).get("cibil_score") or "not given",
        "summary": {
            "number_of_loans": ov["count"],
            "total_outstanding": L.inr(ov["total_outstanding"]),
            "total_monthly_emi": L.inr(ov["total_emi"]),
            "total_interest_still_to_pay": L.inr(ov["total_interest_left"]),
            "debt_free_if_paying_as_usual": L.months_text(ov["months_to_debt_free"]) if loans else "no loans added",
            "emi_as_share_of_salary": f"{ov['emi_to_salary_pct']}%" if ov["emi_to_salary_pct"] is not None else "unknown",
        },
        "loans": [{
            "type": L.LOAN_TYPES[l["type"]],
            "lender": l["lender"] or "not given",
            "outstanding": L.inr(l["outstanding"]),
            "rate_per_year": pct(l['rate']),
            "emi": L.inr(l["emi"]),
            "closes_in": L.months_text(l["months_left"]),
            "interest_left": L.inr(l["interest_left"]),
        } for l in ov["loans"]],
        "payoff_plans_highest_rate_first": plans,
        "usual_total_interest": L.inr(plan_now["usual_interest"]) if plan_now else None,
        "balance_transfer": savings,
        "best_banks_for_you": [{
            "bank": b["bank"],
            "likely_rate_from": pct(b["best_rate"]),
            "emi_now_to_new": f"{L.inr(b['emi_now'])} to {L.inr(b['emi_new'])} a month",
            "net_saving_after_fees": L.inr(b["net_saving"]),
            "loans_it_takes": [f"{L.LOAN_TYPES[x['type']]} ({x['lender'] or 'lender not given'})" for x in b["loans"]],
        } for b in banks] or "no partner bank saves money after fees right now",
        "fresh_personal_loan_room": ({
            "emi_room_per_month": L.inr(elig["emi_room"]),
            "rule": f"banks usually keep all EMIs within about {elig['foir_pct']}% of take-home pay",
            "best_offer": (f"{elig['offers'][0]['bank']}: up to about {L.inr(elig['offers'][0]['max_amount'])} "
                           f"from {pct(elig['offers'][0]['rate_min'])} over {elig['offers'][0]['tenure_months']} months")
                          if elig and elig["offers"] else "no offer configured",
        } if elig else "salary not given"),
    }


# ------------------------------------------------------------ fallback

def rules_reply(context, message=""):
    """When the AI isn't available: answer the question from the app's own numbers."""
    s = context["summary"]
    q = (message or "").lower()
    has = lambda *words: any(w in q for w in words)
    if s["number_of_loans"] == 0:
        return ("Add your loans first, or upload your CIBIL report and I'll add them for you. "
                "Then I can show you which bank gives you a lower rate and EMI, and how to close your loans sooner.")
    n = s["number_of_loans"]
    banks = context.get("best_banks_for_you")
    plans = context["payoff_plans_highest_rate_first"]

    if re.search(r"\b(hi|hello|hey|hii+|namaste|namaskar)\b", q) and len(q) < 25:
        return (f"Hi! You have {n} loan{'s' if n != 1 else ''} with {s['total_outstanding']} left. "
                "Ask me which bank can lower your EMI, how to close your loans faster, or how much more you can borrow.")
    if has("bank", "rate", "interest", "transfer", "cheap", "lower", "emi kam", "byaj", "best"):
        if isinstance(banks, list) and banks:
            b = banks[0]
            more = f" {len(banks) - 1} other bank{'s' if len(banks) > 2 else ''} can also help." if len(banks) > 1 else ""
            return (f"{b['bank']} is your best option: from {b['likely_rate_from']} a year, your EMI goes from "
                    f"{b['emi_now_to_new']}, and you save {b['net_saving_after_fees']} after all fees.{more} "
                    "Open Best banks for you on the home screen and tap Get this offer.")
        return ("Right now none of our partner banks would save you money after fees. "
                "Tap Call me and our executive will check other options for you.")
    if has("close", "faster", "prepay", "extra", "debt free", "debt-free", "jaldi", "finish", "pay off"):
        p = plans.get("pay_5000_extra_per_month")
        if p:
            return (f"Paying ₹5,000 extra a month, starting with {p['close_in_this_order'][0]}, saves "
                    f"{p['interest_saved']} and makes you debt-free in {p['debt_free_in']} instead of "
                    f"{s['debt_free_if_paying_as_usual']}. Open Close faster to try other amounts.")
    if has("new loan", "borrow", "eligible", "eligibility", "how much", "kitna", "more loan"):
        room = context.get("fresh_personal_loan_room")
        if isinstance(room, dict):
            return (f"You have about {room['emi_room_per_month']} a month of EMI room ({room['rule']}). "
                    f"Best offer: {room['best_offer']}. Open New loan to see the details.")
        return "Add your monthly take-home salary in Account, and I'll show how much banks would usually lend you."
    if has("cibil", "score", "credit score"):
        score = context.get("cibil_score")
        if score and score != "not given":
            band = "excellent" if int(score) >= 750 else "fair" if int(score) >= 700 else "low"
            return (f"Your CIBIL score is {score}, which banks see as {band}. "
                    + ("You should get the lowest rates banks offer." if band == "excellent"
                       else "Paying every EMI and card bill on time, and keeping card use under 30% of the limit, raises it."))
        return "Upload your free CIBIL report from the CIBIL score card on the home screen, and I'll read your score and loans from it."
    if has("emi", "salary", "afford", "too high"):
        return (f"Your EMIs are {s['total_monthly_emi']} a month, {s['emi_as_share_of_salary']} of your take-home pay. "
                "Banks get careful when EMIs go above about half your salary.")

    lines = [f"You have {n} loan{'s' if n != 1 else ''} with {s['total_outstanding']} left and "
             f"{s['total_interest_still_to_pay']} of interest still to pay. Paying as usual, you're debt-free in "
             f"{s['debt_free_if_paying_as_usual']}."]
    if isinstance(banks, list) and banks:
        lines.append(f"{banks[0]['bank']} could save you {banks[0]['net_saving_after_fees']} after fees.")
    lines.append("For anything else, tap Call me and our executive will help.")
    return " ".join(lines)


# ------------------------------------------------------------------ ask

def ask(message, history, profile, loans, offers, voice=False):
    """Returns (reply_text, provider_used)."""
    context = build_context(profile, loans, offers)
    system = SYSTEM_PROMPT + (VOICE_NOTE if voice else "") + \
        "\n\nCUSTOMER DATA (calculated by the app):\n" + json.dumps(context, ensure_ascii=False, indent=1)
    history = [{"role": m["role"], "content": str(m["content"])[:2000]}
               for m in (history or [])[-12:] if m.get("role") in ("user", "assistant") and m.get("content")]
    message = (message or "").strip()[:2000]
    p = provider()
    if p == "none":
        return rules_reply(context, message), "rules"
    fn = {"gemini": _gemini, "claude": _claude, "sarvam": _sarvam}[p]
    try:
        reply = fn(system, history, message)
    except Exception as exc:
        # The AI is down, rate-limited or misconfigured: still answer from the app's numbers.
        print(f"[ritu] {p} failed: {exc}")
        return rules_reply(context, message), "rules"
    if not reply:
        return rules_reply(context, message), "rules"
    return reply, p


def check():
    """For the admin AI check: try one tiny question and report what happened."""
    p = provider()
    if p == "none":
        return {"provider": provider_label(), "ok": False, "error": "No AI key is set, so Ritu answers from the app's numbers only."}
    fn = {"gemini": _gemini, "claude": _claude, "sarvam": _sarvam}[p]
    try:
        reply = fn("Reply with the single word: ready", [], "Are you ready?")
        return {"provider": provider_label(), "ok": bool(reply), "reply": (reply or "")[:80]}
    except Exception as exc:
        return {"provider": provider_label(), "ok": False, "error": str(exc)[:300]}
