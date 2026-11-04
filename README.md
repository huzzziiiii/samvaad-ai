# Credwise

**Your loans, sorted.** An AI loan advisor for salaried employees in India.

Customers add their loans and Credwise shows them how to close them faster, how much interest a little extra each month saves, which loans are worth moving to a cheaper lender after every fee, and how much more they could borrow. Ritu, the advisor, answers questions about *their* loans in English or Hindi, by text or voice. When they want a balance transfer or a new loan, one tap sends the request to the Credwise team, who process it directly with the bank.

Two rules keep it trustworthy:
- **The AI never calculates.** Every number comes from `core/loans.py` (EMIs, payoff plans, balance-transfer savings after fees, eligibility). Ritu only explains those numbers.
- **The AI never sees who the customer is.** No name, email, phone or employer is sent to it, only loan types, lenders, amounts and rates.

## What's in the app

There is no website: every address opens the phone app at `/app`.

| Part | For | What it does |
|---|---|---|
| `/app` | Customers | Sign in, fill in your details (name, mobile, age, salary, company), upload a CIBIL report (active loans are read automatically and can be edited or removed), Best banks for you, Lower my rate, New loan, Close faster, Call me, Ask Ritu, request tracking, account. Installs on phones like an app. |
| Admin mode (inside `/app`) | You | Opens automatically for admin emails: requests with status and notes, live activity feed and alerts, customers (with their CIBIL report), bank rates, Excel export |
| `/api/admin/ai-check` | You | Tells you whether Ritu's AI is answering |
| `/privacy` | Everyone | How customer data is used |

## Run it on your laptop (no accounts needed)

```bash
pip install -r requirements.txt
cp .env.example .env      # optional: add GEMINI_API_KEY for Ritu's AI answers
python app.py             # open http://localhost:5000/app
```

Without Supabase it runs in **local test mode**: any email signs you in, data is saved in `data/samvaad.db`, and whoever signs in gets admin mode. Without an AI key, Ritu answers from the calculated numbers.

Run the maths tests with `python tests/test_loans.py`.

## Go live (Vercel + Supabase)

1. **Supabase** (free): create a project at [supabase.com](https://supabase.com). In **SQL Editor**, paste and run `supabase/schema.sql`. In **Authentication → Sign In / Providers**, keep Email on (turn off "Confirm email" while testing if you like).
2. **Gemini** (free): create an API key in Google AI Studio.
3. **Vercel → Project → Settings → Environment Variables**, add:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (Supabase → Project Settings → API)
   - `SECRET_KEY`: any long random string
   - `ADMIN_EMAILS`: your email
   - `GEMINI_API_KEY` (and optionally `SARVAM_API_KEY` for voice)
4. Redeploy. Sign up in the app with your admin email; admin mode opens. Go to **More → Banks** and replace the sample banks with the lenders you're empanelled with.

Before real customers use it, move Ritu to a paid AI tier (`AI_PROVIDER=claude` with `ANTHROPIC_API_KEY`, or Gemini's paid tier): on Gemini's free tier, Google may use the data to improve its products.

## Project layout

```
app.py                 Flask app: wires the app together; every address opens /app
customer.py            Customer app routes: sign-in, details, loans, CIBIL report, best banks, Ask Ritu, requests
admin.py               Admin mode routes: requests, customers, activity, bank rates, Excel export, AI check, daily cleanup
core/loans.py          Loan maths: EMIs, payoff plans, balance transfers, best banks, eligibility
core/advisor.py        Ritu the advisor: Gemini (with backup models) / Claude / Sarvam, anonymised context
core/report.py         Reads CIBIL PDFs with Claude (score and active loans only)
core/store.py          Database: Supabase in production, SQLite locally
core/auth.py           Sign-in: Supabase accounts, or local test mode
core/limits.py         Daily and per-minute limits
core/cleanup.py        Deletes CIBIL reports 6 months after upload
core/export.py         Excel export for admin
core/listen.py, speak.py, respond.py   Sarvam voice for Ask Ritu
core/paths.py          Where files are written (data/ or /tmp on Vercel)
supabase/schema.sql    Tables for Supabase (row-level security on)
tests/test_loans.py    Maths tests
templates/mobile.html  The app
templates/privacy.html Privacy page
public/static/m/       App JavaScript, styles and icons
```

## Environment variables

| Variable | Used for |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Ritu's AI answers (free tier to start) |
| `AI_PROVIDER` | `auto`, `gemini`, `claude` or `sarvam` |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | Claude instead of Gemini (paid) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` | Database and customer accounts |
| `SUPABASE_GOOGLE_LOGIN` | `1` to show "Continue with Google" (after enabling it in Supabase) |
| `SECRET_KEY` | Signs the login cookie. Required on Vercel |
| `SUPPORT_PHONE` | Your number for the app's Call us / WhatsApp buttons, with 91 in front |
| `CLAUDE_REPORT_MODEL` | Model that reads CIBIL PDFs (defaults to `CLAUDE_MODEL`). Needs `ANTHROPIC_API_KEY` |
| `ADMIN_EMAILS` | Who gets admin mode in the app |
| `SARVAM_API_KEY` | Voice in Ask Ritu |

---

Built by Mohammed Huzaifa, CSE (AI & ML), Bengaluru. The voice and calling tools are built on Sarvam AI.
