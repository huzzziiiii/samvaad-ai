"""Samvaad's loan maths. Every number the customer sees comes from here.

The AI advisor never calculates anything itself: it is given the results of
these functions and only explains them. Keep this module pure (no I/O) so it
is easy to test.

Conventions
- Money is in rupees (float), rates are annual percentages (14.0 = 14% p.a.).
- Interest is compounded monthly on the reducing balance, the way Indian
  banks calculate EMIs.
"""
import math

MAX_MONTHS = 600  # 50 years: anything longer means the EMI never clears the loan

LOAN_TYPES = {
    "personal": "Personal loan",
    "home": "Home loan",
    "car": "Car loan",
    "two_wheeler": "Two-wheeler loan",
    "credit_card": "Credit card",
    "education": "Education loan",
    "gold": "Gold loan",
    "business": "Business loan",
    "consumer": "Consumer durable loan",
    "other": "Other loan",
}

# Typical foreclosure / part-prepayment charge banks apply when you close or
# move a loan early (% of outstanding). These are ASSUMPTIONS shown to the user
# as editable defaults, not facts about any particular bank. Floating-rate home
# loans to individuals can't carry foreclosure charges under RBI rules.
DEFAULT_FORECLOSURE_PCT = {
    "personal": 4.0,
    "home": 0.0,
    "car": 4.0,
    "two_wheeler": 4.0,
    "credit_card": 0.0,
    "education": 0.0,
    "gold": 1.0,
    "business": 4.0,
    "consumer": 2.0,
    "other": 3.0,
}

# Share of take-home salary banks usually allow for all EMIs together (FOIR).
DEFAULT_FOIR = 0.50

# Longest tenure assumed for a fresh loan of each type, in months.
DEFAULT_NEW_TENURE = {
    "personal": 60,
    "home": 240,
    "car": 84,
    "two_wheeler": 36,
    "education": 120,
    "business": 60,
    "gold": 12,
    "consumer": 24,
    "other": 60,
    "credit_card": 36,
}


# ------------------------------------------------------------------ basics

def monthly_rate(annual_pct):
    return max(0.0, float(annual_pct)) / 1200.0


def emi(principal, annual_pct, months):
    """Standard reducing-balance EMI."""
    principal, months = float(principal), int(months)
    if principal <= 0 or months <= 0:
        return 0.0
    r = monthly_rate(annual_pct)
    if r == 0:
        return principal / months
    f = (1 + r) ** months
    return principal * r * f / (f - 1)


def months_to_close(balance, annual_pct, payment):
    """Months until `balance` is paid off paying `payment` a month.
    Returns None when the payment doesn't even cover the monthly interest."""
    balance, payment = float(balance), float(payment)
    if balance <= 0:
        return 0
    if payment <= 0:
        return None
    r = monthly_rate(annual_pct)
    if r == 0:
        return math.ceil(balance / payment)
    if payment <= balance * r:
        return None
    n = -math.log(1 - balance * r / payment) / math.log(1 + r)
    return min(MAX_MONTHS, math.ceil(n - 1e-9))


def interest_left(balance, annual_pct, payment):
    """Total interest still to pay if the customer keeps paying `payment`."""
    months = months_to_close(balance, annual_pct, payment)
    if months is None:
        return None
    total, b, r = 0.0, float(balance), monthly_rate(annual_pct)
    for _ in range(months):
        i = b * r
        total += i
        b = b + i - min(payment, b + i)
        if b <= 0.005:
            break
    return total


def max_principal(payment, annual_pct, months):
    """Largest loan a monthly payment can support (inverse of emi())."""
    payment, months = float(payment), int(months)
    if payment <= 0 or months <= 0:
        return 0.0
    r = monthly_rate(annual_pct)
    if r == 0:
        return payment * months
    return payment * ((1 + r) ** months - 1) / (r * (1 + r) ** months)


# ------------------------------------------------------------- normalising

def clean_loan(raw):
    """Validate and normalise one loan dict coming from the user.
    Raises ValueError with a message the user can act on."""
    def num(key, label, minimum=0.0, required=True):
        value = raw.get(key)
        if value in (None, ""):
            if required:
                raise ValueError(f"{label} is missing.")
            return None
        try:
            value = float(str(value).replace(",", "").replace("₹", "").strip())
        except ValueError:
            raise ValueError(f"{label} must be a number.")
        if value < minimum:
            raise ValueError(f"{label} can't be below {minimum:g}.")
        return value

    loan_type = raw.get("type") or "other"
    if loan_type not in LOAN_TYPES:
        loan_type = "other"
    lender = (raw.get("lender") or "").strip()[:60]
    outstanding = num("outstanding", "Amount left to pay", 1)
    rate = num("rate", "Interest rate", 0)
    if rate > 60:
        raise ValueError("Interest rate looks too high. Enter the yearly rate, e.g. 14 for 14%.")
    payment = num("emi", "Monthly EMI", 1, required=loan_type != "credit_card")
    if payment is None:
        # Credit cards have no EMI: use the usual minimum due (5%, at least ₹200).
        payment = max(200.0, outstanding * 0.05)
    months = num("months_left", "Months left", 1, required=False)
    foreclosure = num("foreclosure_pct", "Foreclosure charge", 0, required=False)
    if foreclosure is None:
        foreclosure = DEFAULT_FORECLOSURE_PCT[loan_type]

    if months_to_close(outstanding, rate, payment) is None:
        raise ValueError("This EMI doesn't cover the monthly interest, so the loan would never close. "
                         "Check the amount left, the rate and the EMI.")
    return {
        "type": loan_type,
        "lender": lender,
        "outstanding": round(outstanding, 2),
        "rate": round(rate, 2),
        "emi": round(payment, 2),
        "months_left": int(months) if months else None,
        "foreclosure_pct": round(foreclosure, 2),
        "source": "cibil" if raw.get("source") == "cibil" else "typed",
    }


# --------------------------------------------------------------- one loan

def loan_summary(loan):
    months = months_to_close(loan["outstanding"], loan["rate"], loan["emi"])
    interest = interest_left(loan["outstanding"], loan["rate"], loan["emi"])
    return {
        "months_left": months,
        "interest_left": round(interest or 0, 0),
        "total_left": round(loan["outstanding"] + (interest or 0), 0),
    }


# ------------------------------------------------------------ whole picture

def overview(loans, salary=None):
    """Dashboard numbers for all of a customer's loans."""
    total_outstanding = sum(l["outstanding"] for l in loans)
    total_emi = sum(l["emi"] for l in loans)
    per_loan, total_interest, longest = [], 0.0, 0
    for l in loans:
        s = loan_summary(l)
        per_loan.append({**l, **s})
        total_interest += s["interest_left"]
        longest = max(longest, s["months_left"] or 0)
    result = {
        "count": len(loans),
        "total_outstanding": round(total_outstanding, 0),
        "total_emi": round(total_emi, 0),
        "total_interest_left": round(total_interest, 0),
        "months_to_debt_free": longest,
        "loans": per_loan,
        "emi_to_salary_pct": None,
    }
    if salary:
        result["emi_to_salary_pct"] = round(100 * total_emi / float(salary), 1)
    return result


def _simulate(loans, extra=0.0, strategy="avalanche", rollover=True):
    """Month-by-month payoff of several loans.

    Every loan gets its own EMI. `extra` (and, with rollover, the EMIs of loans
    already closed) goes to one target loan at a time, chosen by `strategy`:
    avalanche = highest interest rate first, snowball = smallest balance first.
    """
    state = [{"i": i, "b": float(l["outstanding"]), "r": monthly_rate(l["rate"]),
              "emi": float(l["emi"]), "rate": float(l["rate"]), "closed_at": None}
             for i, l in enumerate(loans)]
    freed = 0.0
    total_interest = 0.0
    month = 0
    while any(s["b"] > 0.5 for s in state) and month < MAX_MONTHS:
        month += 1
        for s in state:
            if s["b"] > 0.5:
                interest = s["b"] * s["r"]
                total_interest += interest
                s["b"] += interest
        pool = extra + (freed if rollover else 0.0)
        for s in state:
            if s["b"] > 0.5:
                pay = min(s["emi"], s["b"])
                s["b"] -= pay
        open_loans = [s for s in state if s["b"] > 0.5]
        if open_loans and pool > 0:
            key = (lambda s: (-s["rate"], s["b"])) if strategy == "avalanche" else (lambda s: (s["b"], -s["rate"]))
            for s in sorted(open_loans, key=key):
                if pool <= 0:
                    break
                pay = min(pool, s["b"])
                s["b"] -= pay
                pool -= pay
        for s in state:
            if s["b"] <= 0.5 and s["closed_at"] is None:
                s["b"] = 0.0
                s["closed_at"] = month
                freed += s["emi"]
    return {
        "months": month,
        "total_interest": total_interest,
        "closed_at": {s["i"]: s["closed_at"] for s in state},
    }


def payoff_plan(loans, extra=0.0, strategy="avalanche"):
    """Compare paying as usual with the plan (extra money + rolling freed EMIs)."""
    if not loans:
        return None
    extra = max(0.0, float(extra or 0))
    base = _simulate(loans, 0.0, strategy, rollover=False)
    plan = _simulate(loans, extra, strategy, rollover=True)
    order = sorted(range(len(loans)), key=lambda i: (plan["closed_at"][i] or MAX_MONTHS))
    return {
        "strategy": strategy,
        "extra": round(extra, 0),
        "usual_months": base["months"],
        "plan_months": plan["months"],
        "months_saved": max(0, base["months"] - plan["months"]),
        "usual_interest": round(base["total_interest"], 0),
        "plan_interest": round(plan["total_interest"], 0),
        "interest_saved": round(max(0.0, base["total_interest"] - plan["total_interest"]), 0),
        "order": [{
            "index": i,
            "type": loans[i]["type"],
            "lender": loans[i].get("lender", ""),
            "rate": loans[i]["rate"],
            "closes_in_months": plan["closed_at"][i],
            "usual_months": base["closed_at"][i],
        } for i in order],
    }


# ------------------------------------------------------- balance transfer

# Card dues and small loans are usually refinanced with a personal loan.
REFINANCED_AS = {"credit_card": "personal", "consumer": "personal", "other": "personal"}
# Loans that make sense to merge into one personal loan. Home, car, education and
# gold loans are secured and usually cheaper, so they're kept separate.
CONSOLIDATABLE = ("personal", "credit_card", "consumer", "other", "two_wheeler", "business")


def offer_fits(offer, loan_type):
    """Can this bank offer take over a loan of this type?"""
    if not offer.get("active", True):
        return False
    return offer.get("product") in (loan_type, REFINANCED_AS.get(loan_type))


def transfer_options(loan, offers, months=None):
    """Net saving from moving one loan to each cheaper offer.

    The new loan keeps the same remaining tenure, so the saving is purely from
    the lower rate, minus the bank's processing fee and the current lender's
    foreclosure charge. Offers give a rate range; the best case uses the lowest
    rate and the cautious case the highest.
    """
    months = months or months_to_close(loan["outstanding"], loan["rate"], loan["emi"])
    if not months:
        return []
    current_interest = interest_left(loan["outstanding"], loan["rate"], loan["emi"]) or 0
    foreclosure = loan["outstanding"] * loan.get("foreclosure_pct", 0) / 100
    results = []
    for offer in offers:
        if not offer_fits(offer, loan["type"]):
            continue
        lo, hi = float(offer["rate_min"]), float(offer.get("rate_max") or offer["rate_min"])
        if lo >= loan["rate"]:
            continue
        fee = loan["outstanding"] * float(offer.get("processing_fee_pct") or 0) / 100
        tenure = min(months, int(offer.get("max_tenure_months") or months))

        def case(rate):
            new_emi = emi(loan["outstanding"], rate, tenure)
            new_interest = new_emi * tenure - loan["outstanding"]
            return {
                "rate": rate,
                "new_emi": round(new_emi, 0),
                "emi_change": round(new_emi - loan["emi"], 0),
                "interest_saved": round(current_interest - new_interest, 0),
                "net_saving": round(current_interest - new_interest - fee - foreclosure, 0),
            }

        best, cautious = case(lo), case(min(hi, loan["rate"]))
        if best["net_saving"] <= 0:
            continue
        results.append({
            "bank": offer["name"],
            "bank_id": offer.get("id"),
            "tenure_months": tenure,
            "processing_fee": round(fee, 0),
            "foreclosure_charge": round(foreclosure, 0),
            "best": best,
            "cautious": cautious,
        })
    results.sort(key=lambda r: -r["best"]["net_saving"])
    return results


RETIRE_AGE = 60  # banks usually want a loan closed by about this age


def likely_rate(offer, cibil_score=None):
    """The rate a bank would probably offer this customer.

    Banks quote a range and give their best rate to strong credit scores:
    750+ gets the lowest rate, 700-749 the middle, below 700 the top of the
    range. With no score yet we assume the middle.
    """
    lo = float(offer["rate_min"])
    hi = float(offer.get("rate_max") or lo)
    try:
        score = int(cibil_score) if cibil_score else None
    except (TypeError, ValueError):
        score = None
    if score and score >= 750:
        rate = lo
    elif score and score < 700:
        rate = hi
    else:
        rate = (lo + hi) / 2
    return round(rate, 2)


def best_banks(loans, offers, profile=None, limit=5):
    """Banks ranked by how much they would save this customer across all their loans.

    For each bank, every loan it can take over is moved at the customer's likely
    rate, keeping the remaining tenure (capped by the bank's maximum and by the
    customer's age). A loan is only counted if it saves money after the bank's
    processing fee and the current lender's foreclosure charge.
    """
    profile = profile or {}
    age = profile.get("age")
    try:
        age_cap = max(12, (RETIRE_AGE - int(age)) * 12) if age else None
    except (TypeError, ValueError):
        age_cap = None
    score = profile.get("cibil_score")
    salary = float(profile.get("salary") or 0)
    total_emi = sum(l["emi"] for l in loans)

    banks = {}
    for loan in loans:
        months = months_to_close(loan["outstanding"], loan["rate"], loan["emi"])
        if not months:
            continue
        current_interest = interest_left(loan["outstanding"], loan["rate"], loan["emi"]) or 0
        foreclosure = loan["outstanding"] * loan.get("foreclosure_pct", 0) / 100
        for offer in offers:
            if not offer_fits(offer, loan["type"]):
                continue
            rate = likely_rate(offer, score)
            if rate >= loan["rate"]:
                continue
            tenure = min(months, int(offer.get("max_tenure_months") or months))
            if age_cap:
                tenure = min(tenure, age_cap)
            new_emi = emi(loan["outstanding"], rate, tenure)
            fee = loan["outstanding"] * float(offer.get("processing_fee_pct") or 0) / 100
            net = current_interest - (new_emi * tenure - loan["outstanding"]) - fee - foreclosure
            if net <= 0:
                continue
            b = banks.setdefault(offer["name"], {"bank": offer["name"], "loans": []})
            b["loans"].append({
                "loan_id": loan.get("id"),
                "offer_id": offer.get("id"),
                "type": loan["type"],
                "lender": loan.get("lender", ""),
                "outstanding": round(loan["outstanding"], 0),
                "old_rate": loan["rate"],
                "new_rate": rate,
                "rate_range": [float(offer["rate_min"]), float(offer.get("rate_max") or offer["rate_min"])],
                "old_emi": round(loan["emi"], 0),
                "new_emi": round(new_emi, 0),
                "tenure_months": tenure,
                "fees": round(fee + foreclosure, 0),
                "net_saving": round(net, 0),
            })

    out = []
    for b in banks.values():
        b["loans"].sort(key=lambda x: -x["net_saving"])
        emi_now = sum(x["old_emi"] for x in b["loans"])
        emi_new = sum(x["new_emi"] for x in b["loans"])
        b.update(
            bank_id=b["loans"][0]["offer_id"],
            best_rate=min(x["new_rate"] for x in b["loans"]),
            emi_now=round(emi_now, 0),
            emi_new=round(emi_new, 0),
            emi_saving=round(emi_now - emi_new, 0),
            fees=round(sum(x["fees"] for x in b["loans"]), 0),
            net_saving=round(sum(x["net_saving"] for x in b["loans"]), 0),
            emi_to_salary_after=round((total_emi - emi_now + emi_new) / salary * 100) if salary else None,
        )
        out.append(b)
    out.sort(key=lambda b: (-b["net_saving"], -b["emi_saving"]))
    return out[:limit]


def consolidation(selected, offers, profile=None, all_loans=None, limit=5):
    """Merge the chosen loans into ONE personal loan at a lower rate.

    The new loan pays off every chosen loan. Its tenure is the longest time any
    of them still had left (capped by the bank and the customer's age), so the
    monthly EMI goes down. A bank is only shown if the customer still saves
    money overall after the processing fee and foreclosure charges.
    """
    profile = profile or {}
    chosen = [l for l in selected if l["type"] in CONSOLIDATABLE]
    if len(chosen) < 2:
        return {"loans": chosen, "options": [], "reason": "Pick at least two loans to merge."}
    principal = sum(l["outstanding"] for l in chosen)
    emi_now = sum(l["emi"] for l in chosen)
    months_each = [months_to_close(l["outstanding"], l["rate"], l["emi"]) for l in chosen]
    if not all(months_each):
        return {"loans": chosen, "options": [], "reason": "One of these loans' EMI is too low to ever close it. Check its EMI."}
    interest_now = sum(interest_left(l["outstanding"], l["rate"], l["emi"]) or 0 for l in chosen)
    foreclosure = sum(l["outstanding"] * l.get("foreclosure_pct", 0) / 100 for l in chosen)
    avg_rate = sum(l["rate"] * l["outstanding"] for l in chosen) / principal
    age = profile.get("age")
    try:
        age_cap = max(12, (RETIRE_AGE - int(age)) * 12) if age else None
    except (TypeError, ValueError):
        age_cap = None
    salary = float(profile.get("salary") or 0)
    other_emi = sum(l["emi"] for l in (all_loans or chosen)) - emi_now

    options = []
    for offer in offers:
        if offer.get("product") != "personal" or not offer.get("active", True):
            continue
        rate = likely_rate(offer, profile.get("cibil_score"))
        if rate >= avg_rate:
            continue
        tenure = min(max(months_each), int(offer.get("max_tenure_months") or 60))
        if age_cap:
            tenure = min(tenure, age_cap)
        new_emi = emi(principal, rate, tenure)
        fee = principal * float(offer.get("processing_fee_pct") or 0) / 100
        net = interest_now - (new_emi * tenure - principal) - fee - foreclosure
        if net <= 0:
            continue
        options.append({
            "bank": offer["name"], "bank_id": offer.get("id"),
            "rate": rate, "rate_range": [float(offer["rate_min"]), float(offer.get("rate_max") or offer["rate_min"])],
            "tenure_months": tenure, "new_emi": round(new_emi, 0), "emi_saving": round(emi_now - new_emi, 0),
            "fees": round(fee + foreclosure, 0), "net_saving": round(net, 0),
            "emi_to_salary_after": round((other_emi + new_emi) / salary * 100) if salary else None,
        })
    options.sort(key=lambda o: (-o["net_saving"], -o["emi_saving"]))
    return {
        "loans": [{"id": l.get("id"), "type": l["type"], "lender": l.get("lender", ""), "outstanding": round(l["outstanding"], 0),
                   "rate": l["rate"], "emi": round(l["emi"], 0)} for l in chosen],
        "principal": round(principal, 0), "emi_now": round(emi_now, 0), "avg_rate": round(avg_rate, 2),
        "options": options[:limit],
        "reason": None if options else "None of our partner banks would save you money by merging these loans right now.",
    }


def savings_finder(loans, offers):
    out = []
    for i, loan in enumerate(loans):
        options = transfer_options(loan, offers)
        out.append({"index": i, "loan": loan, "options": options[:3]})
    return out


# -------------------------------------------------------------- fresh loan

def eligibility(salary, loans, offers, loan_type="personal", foir=DEFAULT_FOIR):
    """Rough room for a new loan: banks keep all EMIs within ~FOIR of take-home pay."""
    salary = float(salary or 0)
    if salary <= 0:
        return None
    current_emi = sum(l["emi"] for l in loans)
    room = salary * foir - current_emi
    tenure = DEFAULT_NEW_TENURE.get(loan_type, 60)
    candidates = [o for o in offers if o.get("product") == loan_type and o.get("active", True)]
    result = {
        "loan_type": loan_type,
        "salary": round(salary, 0),
        "current_emi": round(current_emi, 0),
        "foir_pct": round(foir * 100),
        "emi_room": round(max(0.0, room), 0),
        "tenure_months": tenure,
        "offers": [],
    }
    if room <= 0:
        return result
    for o in candidates:
        t = min(tenure, int(o.get("max_tenure_months") or tenure))
        result["offers"].append({
            "bank": o["name"],
            "bank_id": o.get("id"),
            "rate_min": float(o["rate_min"]),
            "tenure_months": t,
            "max_amount": round(max_principal(room, float(o["rate_min"]), t), -3),
        })
    result["offers"].sort(key=lambda x: -x["max_amount"])
    return result


# -------------------------------------------------------------- formatting

def inr(amount):
    """₹12,34,567 (Indian digit grouping)."""
    if amount is None:
        return "—"
    negative = amount < 0
    n = str(int(round(abs(amount))))
    if len(n) > 3:
        head, tail = n[:-3], n[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        n = ",".join(parts) + "," + tail
    return ("-₹" if negative else "₹") + n


def months_text(months):
    if months is None:
        return "never (EMI too low)"
    years, rest = divmod(int(months), 12)
    if years and rest:
        return f"{years} yr {rest} mo"
    if years:
        return f"{years} yr"
    return f"{rest} mo"
