"""Ritu, the loan advisor inside the Samvaad app.

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

import requests

from core import loans as L


def pct(x):
    """14.0 -> '14%', 9.5 -> '9.5%'"""
    return f"{float(x):g}%"

TIMEOUT = 40

SYSTEM_PROMPT = """You are Ritu, the loan advisor inside Samvaad, an app that helps salaried employees in India
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
  "Get this done" and the Samvaad team will handle the bank paperwork for them, free of charge.
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


def _gemini(system, history, message):
    model = os.getenv("GEMINI_MODEL") or "gemini-3.8-flash"
    while history and history[0]["role"] == "assistant":  # Gemini wants the user to speak first
        history = history[1:]
    contents = [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                for m in history]
    contents.append({"role": "user", "parts": [{"text": message}]})
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"},
        json={
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"temperature": 0.4, "maxOutputTokens": 700},
        },
        timeout=TIMEOUT,
    )
    if r.status_code == 429:
        raise AdvisorError("Ritu is getting a lot of questions right now (the free AI limit was reached). Try again in a minute.")
    if r.status_code >= 400:
        raise AdvisorError(f"Gemini returned an error ({r.status_code}). Check GEMINI_API_KEY and GEMINI_MODEL.")
    data = r.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts).strip()
    except (KeyError, IndexError):
        raise AdvisorError("Gemini didn't return an answer. Try asking in a different way.")


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
        raise AdvisorError(f"Claude returned an error ({r.status_code}). Check ANTHROPIC_API_KEY and CLAUDE_MODEL.")
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
        "fresh_personal_loan_room": ({
            "emi_room_per_month": L.inr(elig["emi_room"]),
            "rule": f"banks usually keep all EMIs within about {elig['foir_pct']}% of take-home pay",
            "best_offer": (f"{elig['offers'][0]['bank']}: up to about {L.inr(elig['offers'][0]['max_amount'])} "
                           f"from {pct(elig['offers'][0]['rate_min'])} over {elig['offers'][0]['tenure_months']} months")
                          if elig and elig["offers"] else "no offer configured",
        } if elig else "salary not given"),
    }


# ------------------------------------------------------------ fallback

def rules_reply(context):
    """No AI key: a useful, honest answer built only from the numbers."""
    s = context["summary"]
    if s["number_of_loans"] == 0:
        return ("Add your loans in the Loans tab first: the amount left, the interest rate and the EMI. "
                "Then I can show you how to close them faster and where you could save.")
    n = s['number_of_loans']
    lines = [f"You have {n} loan{'s' if n != 1 else ''} with {s['total_outstanding']} left and "
             f"{s['total_interest_still_to_pay']} of interest still to pay. Paying as usual, you're debt-free in "
             f"{s['debt_free_if_paying_as_usual']}."]
    p = context["payoff_plans_highest_rate_first"].get("pay_5000_extra_per_month")
    if p:
        lines.append(f"Paying ₹5,000 extra a month, starting with {p['close_in_this_order'][0]}, saves "
                     f"{p['interest_saved']} and you're debt-free in {p['debt_free_in']}.")
    for item in context["balance_transfer"]:
        if "best_offer" in item:
            lines.append(f"Moving your {item['loan']} to {item['best_offer']} could save {item['net_saving_range']} "
                         f"after fees. Tap \"Get this done\" in Savings and we'll handle it.")
            break
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
        return rules_reply(context), "rules"
    fn = {"gemini": _gemini, "claude": _claude, "sarvam": _sarvam}[p]
    try:
        reply = fn(system, history, message)
    except Exception:
        # The AI is down or rate-limited: still answer from the app's numbers.
        return rules_reply(context), "rules"
    if not reply:
        return rules_reply(context), "rules"
    return reply, p
