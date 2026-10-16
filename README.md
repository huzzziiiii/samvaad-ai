# Samvaad AI

**Ritu, an AI loan advisor that convinces, not just qualifies.**

Most AI voice callers in the DSA space collect lead details and hang up at the first "no". Ritu handles the objection the way a trained DSA caller does: she agrees first, then reframes. She speaks British English by default and switches to Hindi or Hinglish only when the customer does.

Built on Sarvam AI: **Bulbul v3** for her voice, **Saaras v3** to listen (with automatic language detection), and **sarvam-105b** to think. Inspired by three months cold-calling for personal loans at a DSA.

## What it does

- **Talk to Ritu in the browser** (`/talk`): a full voice call. The page records you, detects when you stop speaking, and plays Ritu's reply. There's a typing fallback for noisy rooms.
- **Call log** (`/dashboard`): every call with its outcome (interested, call back, not interested), searchable transcripts, and the lead list.
- **Eleven objections handled** in English and Hindi, including "I'll go directly to the bank", "How can I trust an AI?", "My CIBIL is low" and "I already have loans".
- **Real phone calls** through Twilio: Ritu rings the customer's phone, with a live transcript on the Phone page and a CSV batch dialer.
- **WhatsApp payslip follow-ups** through Twilio.

## Run it locally

```bash
pip install -r requirements.txt
cp .env.example .env        # add your SARVAM_API_KEY
python app.py               # open http://localhost:5000
```

Microphone voice loop in the terminal:

```bash
python scripts/conversation.py
```

## Deploy on Vercel

1. Push this repo to GitHub.
2. On [vercel.com/new](https://vercel.com/new), import the repo. Vercel detects the Flask app in `app.py`.
3. Under **Environment Variables**, add `SARVAM_API_KEY`.
4. Deploy, then open `https://<your-project>.vercel.app/talk` on your phone.

On Vercel the web call keeps its state in the browser, and Ritu's audio comes back inside each response, so no server files are needed. Vercel can't keep files, so finished calls are saved in the browser that made them and show up in that browser's call log. For a permanent shared call log, and for real phone calls, run it on an always-on server (your laptop with a tunnel, or Railway) (`Procfile` and `railway.json` are included).

## Real phone calls (Twilio)

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
app.py                 Flask app: pages, call APIs, Twilio and Exotel webhooks
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
| `SARVAM_API_KEY` | Required. Voice, listening and replies |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Real phone calls |
| `PUBLIC_BASE_URL` | Public https link Twilio sends calls to |
| `CALL_ACCESS_KEY` | Password for starting calls from the Phone page |
| `CALL_HOURS` | Hours (India time) when calls may be placed, default `9-21` |
| `TWILIO_WHATSAPP_FROM` | WhatsApp follow-ups |
| `EXOTEL_SID`, `EXOTEL_TOKEN`, `EXOTEL_VIRTUAL_NUMBER`, `EXOTEL_CALLBACK_BASE_URL` | Older Exotel integration (optional) |

---

Built by Mohammed Huzaifa, CSE (AI & ML), Bengaluru.
