"""Run: python -m pytest tests  (or: python tests/test_loans.py)"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core import loans as L


def close(a, b, tol=1.0):
    assert abs(a - b) <= tol, f"{a} != {b}"


def test_emi_matches_bank_calculators():
    close(L.emi(100000, 12, 12), 8884.88, 0.01)        # ₹1L, 12%, 1 yr
    close(L.emi(500000, 10.5, 60), 10746.95, 0.05)     # ₹5L, 10.5%, 5 yr
    close(L.emi(3000000, 8.5, 240), 26035, 0.5)        # ₹30L, 8.5%, 20 yr (banks quote ₹26,035)
    close(L.emi(60000, 0, 12), 5000, 0.001)


def test_months_and_interest_roundtrip():
    p, r, n = 500000, 14, 48
    e = L.emi(p, r, n)
    assert L.months_to_close(p, r, e) == n
    close(L.interest_left(p, r, e), e * n - p, 2)
    assert L.months_to_close(100000, 24, 1500) is None   # EMI below monthly interest (2000)
    close(L.max_principal(e, r, n), p, 1)


def test_clean_loan_validation():
    ok = L.clean_loan({"type": "personal", "lender": "X", "outstanding": "3,00,000", "rate": "14", "emi": "10250"})
    assert ok["outstanding"] == 300000 and ok["foreclosure_pct"] == 4.0
    for bad, msg in [({"outstanding": "", "rate": 10, "emi": 100}, "missing"),
                     ({"outstanding": 100000, "rate": 140, "emi": 5000}, "too high"),
                     ({"outstanding": 100000, "rate": 24, "emi": 1500}, "never close")]:
        try:
            L.clean_loan(bad); assert False, "should fail"
        except ValueError as e:
            assert msg in str(e), e


def test_payoff_plan_extra_saves_money_and_avalanche_targets_costliest():
    loans = [
        L.clean_loan({"type": "credit_card", "outstanding": 80000, "rate": 36, "emi": 4000}),
        L.clean_loan({"type": "personal", "outstanding": 300000, "rate": 14, "emi": 10250}),
        L.clean_loan({"type": "car", "outstanding": 400000, "rate": 9.5, "emi": 9000}),
    ]
    usual = L.payoff_plan(loans, 0)
    total_interest = sum(L.interest_left(l["outstanding"], l["rate"], l["emi"]) for l in loans)
    close(usual["usual_interest"], total_interest, 5)
    plan = L.payoff_plan(loans, 5000, "avalanche")
    assert plan["interest_saved"] > 0 and plan["months_saved"] > 0
    assert plan["order"][0]["type"] == "credit_card"          # 36% closed first
    snow = L.payoff_plan(loans, 5000, "snowball")
    assert snow["order"][0]["type"] == "credit_card"           # also smallest balance
    assert plan["plan_interest"] <= snow["plan_interest"] + 1  # avalanche never costs more


def test_transfer_only_when_net_positive():
    loan = L.clean_loan({"type": "personal", "outstanding": 300000, "rate": 16, "emi": 10550})
    offers = [
        {"id": "a", "name": "Bank A", "product": "personal", "rate_min": 10.5, "rate_max": 13, "processing_fee_pct": 1},
        {"id": "b", "name": "Bank B", "product": "personal", "rate_min": 15.8, "rate_max": 16, "processing_fee_pct": 2},
        {"id": "c", "name": "Bank C", "product": "home", "rate_min": 8, "rate_max": 9},
    ]
    opts = L.transfer_options(loan, offers)
    assert [o["bank"] for o in opts] == ["Bank A"], opts        # B saves less than its fees, C wrong product
    a = opts[0]
    assert a["best"]["net_saving"] > a["cautious"]["net_saving"]
    close(a["processing_fee"], 3000) ; close(a["foreclosure_charge"], 12000)


def test_eligibility_uses_foir():
    loans = [L.clean_loan({"type": "car", "outstanding": 400000, "rate": 9.5, "emi": 9000})]
    offers = [{"id": "a", "name": "Bank A", "product": "personal", "rate_min": 11, "max_tenure_months": 60}]
    e = L.eligibility(60000, loans, offers, "personal")
    assert e["emi_room"] == 21000
    close(e["offers"][0]["max_amount"], round(L.max_principal(21000, 11, 60), -3), 1)
    assert L.eligibility(10000, loans, offers)["emi_room"] == 0


def test_inr_grouping():
    assert L.inr(1234567) == "₹12,34,567"
    assert L.inr(999) == "₹999"
    assert L.inr(100000) == "₹1,00,000"
    assert L.inr(-2500) == "-₹2,500"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
