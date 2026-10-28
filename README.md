# Samvaad

**Your loans, sorted.** An AI loan advisor for salaried employees in India.

Customers add their loans and Samvaad shows them how to close them faster, how much interest a little extra each month saves, which loans are worth moving to a cheaper lender after every fee, and how much more they could borrow. Ritu, the advisor, answers questions about *their* loans in English or Hindi, by text or voice. When they want a balance transfer or a new loan, one tap sends the request to the Samvaad team, who process it directly with the bank.

Two rules keep it trustworthy:
- **The AI never calculates.** Every number comes from `core/loans.py` (EMIs, payoff plans, balance-transfer savings after fees, eligibility). Ritu only explains those numbers.
- **The AI never sees who the customer is.** No name, email, phone or employer is sent to it, only loan types, lenders, amounts and rates.

## What's in the app

| Page | For | What it does |
|---|---|---|
| `/` | Everyone | Landing page |
| `/app` | Customers | Overview + payoff plan, Loans, Savings, Ask Ritu, Requests. Installs on phones like an app. |
| `/admin` | You | Customer requests with status and notes, the bank rate table, the older calling tools |
| `/demo`, `/talk`, `/phone`, `/dashboard` | You | Ritu the AI caller (the original Samvaad AI: Sarvam voice demo, Twilio calls, call log) |

## Run it on your laptop (no accounts needed)

```bash
pip install -r requirements.txt
cp .env.example .env      # optional: add GEMINI_API_KEY for Ritu's AI answers
python app.py             # open http://localhost:5000
```

Without Supabase it runs in **local test mode**: any email signs you in, data is saved in `data/samvaad.db`, and whoever signs in can open `/admin`. Without an AI key, Ritu answers from the calculated numbers.

Run the maths tests with `python tests/test_loans.py`.

## Go live (Vercel + Supabase)

1. **Supabase** (free): create a project at [supabase.com](https://supabase.com). In **SQL Editor**, paste and run `supabase/schema.sql`. In **Authentication → Sign In / Providers**, keep Email on (turn off "Confirm email" while testing if you like).
2. **Gemini** (free): create an API key in Google AI Studio.
3. **Vercel → Project → Settings → Environment Variables**, add:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (Supabase → Project Settings → API)
   - `SECRET_KEY`: any long random string
   - `ADMIN_EMAILS`: your email
   - `GEMINI_API_KEY` (and optionally `SARVAM_API_KEY` for voice)
4. Redeploy. Sign up on the live site with your admin email, open `/admin` → **Bank rates**, and replace the sample banks with the lenders you're empanelled with.

Before real customers use it, move Ritu to a paid AI tier (`AI_PROVIDER=claude` with `ANTHROPIC_API_KEY`, or Gemini's paid tier): on Gemini's free tier, Google may use the data to improve its products.

## Ritu, the AI caller (calling tools)

The original Samvaad AI is still here for you in `/admin` → Calling tools: Ritu handles loan objections on calls in English and Hindi, built on Sarvam AI (Bulbul v3 voice, Saaras v3 listening). `/talk` is the browser demo; `/phone` makes real calls through Twilio.

### Real phone calls (Twilio)

On the **Phone** page (`/phone`) you enter a name and number, and Ritu rings that phone. The customer picks up a normal call and talks to her; you follow a live transcript, and the finished call lands in the call log. Each lead in the call log also has a **Call** link, and `python scripts/auto_caller.py --mode twilio` dials the whole `data/leads.csv` list.

Phone calls need a server that stays running (your laptop with a tunnel, or Railway). They don't run on Vercel.

**1. Twilio account**
1. Sign up at [twilio.com](https://www.twilio.com/try-twilio) and **upgrade the account** (add a balance). Twilio's free trial strips the `<Record>` verb and only allows its own sample call flows, so Ritu can't hear customers on a trial.
2. Buy a phone number in the Twilio Console for Ritu to call from.
3. **Allow calls to India**: Voice → Settings → Geo permissions → tick India.
4. Copy your **Account SID** and **Auth Token** from the Console home page.

**2. `.env`**
```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...          # your Twilio number
CALL_ACCESS_KEY=pick-a-password    # the Phone page asks for this
CALL_HOURS=0-24                    # testing only; use 9-21 for real customers
PUBLIC_BASE_URL=https://...        # set in step 3
```

**3. Give Twilio a public link to your laptop**
```
python app.py
cloudflared tunnel --url http://localhost:5000      # in a second terminal
```
Copy the `https://...trycloudflare.com` link into `PUBLIC_BASE_URL`, restart `python app.py`, and open that link with `/phone` on the end. The tunnel link changes every time you restart cloudflared, so update `PUBLIC_BASE_URL` each time (or deploy on Railway for a permanent link).

**How a call works:** Twilio plays Ritu's line and records the customer until they pause for two seconds. Sarvam transcribes it, Ritu's reply is generated and spoken, and the loop continues. Recordings are deleted from Twilio right after transcription. There's a pause of a few seconds while Ritu thinks; Twilio's webhooks are signed, and unsigned requests are rejected.

**Rules for real customers in India:** sales calls are only allowed from 9 am to 9 pm (enforced by `CALL_HOURS`), numbers on the DND list must not be called, and a business calling at scale must be registered for telemarketing (DLT) with TRAI.

## Project layout

```
app.py                 Flask app: wires everything together, plus the calling tools
customer.py            Customer app routes: sign-in, loans, plan, savings, Ask Ritu, requests
admin.py               Admin routes: requests, bank rates
core/loans.py          Loan maths: EMIs, payoff plans, balance transfers, eligibility
core/advisor.py        Ritu the advisor: Gemini / Claude / Sarvam switch, anonymised context
core/store.py          Database: Supabase in production, SQLite locally
core/auth.py           Sign-in: Supabase accounts, or local test mode
supabase/schema.sql    Tables for Supabase (row-level security on)
tests/test_loans.py    Maths tests
core/respond.py        Ritu's script, language choice, reply generation
core/listen.py         Microphone VAD + Sarvam speech-to-text
core/speak.py          Sarvam text-to-speech (voice: ritu)
core/twilio_call.py    Real phone calls through Twilio (dialling, webhooks, live view)
core/phone_call.py     Outcome detection, shared call lines, Exotel ExoML
core/paths.py          Where files are read and written (data/ or /tmp on Vercel)
scripts/               Mic demo, CSV auto-caller, Exotel dialer, WhatsApp follow-up
templates/             HTML pages
public/static/         CSS, JS and self-hosted fonts (Mukta, Tiro Devanagari Hindi)
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
| `ADMIN_EMAILS` | Who can open `/admin` |
| `SARVAM_API_KEY` | Voice in Ask Ritu, and Ritu's voice in the calling tools |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Real phone calls |
| `PUBLIC_BASE_URL` | Public https link Twilio sends calls to |
| `CALL_ACCESS_KEY` | Password for starting calls from the Phone page |
| `CALL_HOURS` | Hours (India time) when calls may be placed, default `9-21` |
| `TWILIO_WHATSAPP_FROM` | WhatsApp follow-ups |
| `EXOTEL_SID`, `EXOTEL_TOKEN`, `EXOTEL_VIRTUAL_NUMBER`, `EXOTEL_CALLBACK_BASE_URL` | Older Exotel integration (optional) |

---

Built by Mohammed Huzaifa, CSE (AI & ML), Bengaluru. The voice and calling tools are built on Sarvam AI.
