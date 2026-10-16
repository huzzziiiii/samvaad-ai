"""Ritu on real phone calls, through Twilio.

How a call runs
---------------
1. start_call() asks Twilio to ring the customer.
2. When they pick up, Twilio requests /twilio/voice. We play Ritu's opener and
   <Record> the customer until they pause.
3. Twilio sends the recording to /twilio/heard. Transcribing, thinking and
   speaking can take several seconds, and Twilio only waits 15 seconds for an
   answer, so that work runs in a background thread while we tell Twilio to
   pause and come back to /twilio/next.
4. /twilio/next plays Ritu's reply when it's ready and records again.
5. /twilio/status tells us when the call ends; the transcript is then saved.

Needs a server that stays running (your laptop with a tunnel, or Railway).
Serverless hosts like Vercel can't keep a call in memory between requests.
"""
import os
import re
import time
import threading
import tempfile
from datetime import datetime, timezone, timedelta

import requests

from core import phone_call as pc
from core import respond as ritu
from core.listen import transcribe
from core.paths import AUDIO_DIR, ON_VERCEL

IST = timezone(timedelta(hours=5, minutes=30))

MAX_CALL_SECONDS = 600       # Twilio hangs up after 10 minutes
RECORD_MAX_SECONDS = 30      # longest single customer turn
RECORD_SILENCE_SECONDS = 2   # pause that ends the customer's turn
MAX_SILENT_TURNS = 2         # then Ritu says goodbye
REPLY_WAIT_SECONDS = 8       # how long one /twilio/next request waits

SESSIONS = {}                # CallSid -> call state (one server process)
_LOCK = threading.Lock()


# ------------------------------------------------------------------ config

def config():
    return {
        "account_sid": os.getenv("TWILIO_ACCOUNT_SID", ""),
        "auth_token": os.getenv("TWILIO_AUTH_TOKEN", ""),
        "from_number": os.getenv("TWILIO_PHONE_NUMBER", ""),
        "base_url": (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/"),
        "access_key": os.getenv("CALL_ACCESS_KEY", ""),
        "hours": os.getenv("CALL_HOURS", "9-21"),
    }


def setup_status():
    """What's missing before Ritu can dial. Shown on the Phone calls page."""
    c = config()
    missing = []
    if ON_VERCEL:
        missing.append("an always-on server (phone calls can't run on Vercel)")
    if not os.getenv("SARVAM_API_KEY"):
        missing.append("SARVAM_API_KEY")
    if not c["account_sid"]:
        missing.append("TWILIO_ACCOUNT_SID")
    if not c["auth_token"]:
        missing.append("TWILIO_AUTH_TOKEN")
    if not c["from_number"]:
        missing.append("TWILIO_PHONE_NUMBER")
    if not c["base_url"].startswith("https://"):
        missing.append("PUBLIC_BASE_URL (your public https link)")
    if not c["access_key"]:
        missing.append("CALL_ACCESS_KEY (a password for starting calls)")
    return {"ready": not missing, "missing": missing, "hours": c["hours"]}


def check_access_key(key):
    expected = config()["access_key"]
    return bool(expected) and isinstance(key, str) and key == expected


def within_calling_hours(now=None):
    """Sales calls in India: 9 am to 9 pm. CALL_HOURS="0-24" turns this off for testing."""
    try:
        start, end = (int(x) for x in config()["hours"].split("-"))
    except ValueError:
        start, end = 9, 21
    hour = (now or datetime.now(IST)).hour
    return start <= hour < end


def normalize_number(raw):
    digits = re.sub(r"[^\d+]", "", raw or "")
    if digits.startswith("00"):
        digits = "+" + digits[2:]
    if not digits.startswith("+"):
        digits = digits.lstrip("0")
        if len(digits) == 10:
            digits = "+91" + digits
        elif len(digits) == 12 and digits.startswith("91"):
            digits = "+" + digits
        else:
            return None
    return digits if re.fullmatch(r"\+\d{10,15}", digits) else None


def _client():
    from twilio.rest import Client
    c = config()
    return Client(c["account_sid"], c["auth_token"])


def url(path):
    return config()["base_url"] + path


# ---------------------------------------------------------------- sessions

def _new_session(call_sid, lead_name="there", phone=None):
    return {
        "call_sid": call_sid,
        "lead_name": lead_name or "there",
        "phone": phone,
        "status": "queued",
        "language": "en-IN",
        "outcome": "unknown",
        "history": [],
        "transcript": [],
        "turn": 0,
        "silent_turns": 0,
        "pending": None,      # {"audio": filename, "ended": bool} when a reply is ready
        "working": False,     # background thread busy
        "saved": False,
        "started_at": datetime.now(IST).isoformat(timespec="seconds"),
        "ended_at": None,
    }


def get_session(call_sid):
    with _LOCK:
        return SESSIONS.get(call_sid)


def public_view(session):
    """What the Phone calls page shows."""
    if not session:
        return None
    return {
        "call_sid": session["call_sid"],
        "lead_name": session["lead_name"],
        "phone": session["phone"],
        "status": session["status"],
        "outcome": session["outcome"],
        "language": "Hindi" if session["language"] == "hi-IN" else "English",
        "transcript": session["transcript"],
        "thinking": session["working"],
        "started_at": session["started_at"],
        "ended_at": session["ended_at"],
    }


# --------------------------------------------------------------- dialling

def start_call(to_number, lead_name="there"):
    """Ring a customer. Returns the Twilio CallSid."""
    from urllib.parse import quote
    c = config()
    to = normalize_number(to_number)
    if not to:
        raise ValueError("That doesn't look like a phone number. Use 10 digits, or +91 and 10 digits.")
    name = (lead_name or "").strip()[:60] or "there"

    call = _client().calls.create(
        to=to,
        from_=c["from_number"],
        url=url("/twilio/voice?name=" + quote(name)),
        method="POST",
        status_callback=url("/twilio/status"),
        status_callback_method="POST",
        status_callback_event=["initiated", "ringing", "answered", "completed"],
        time_limit=MAX_CALL_SECONDS,
    )
    with _LOCK:
        SESSIONS[call.sid] = _new_session(call.sid, name, to)
    return call.sid


def hang_up(call_sid):
    _client().calls(call_sid).update(status="completed")


# ------------------------------------------------------------------ audio

def _say_to_file(session, text):
    """Synthesize Ritu's line, store it where Twilio can fetch it, log it."""
    os.makedirs(AUDIO_DIR, exist_ok=True)
    session["turn"] += 1
    filename = f"{session['call_sid']}_{session['turn']}.wav"
    ritu.synthesize(text, session["language"], os.path.join(AUDIO_DIR, filename))
    session["transcript"].append({"speaker": "Ritu", "text": text})
    return filename


def _download_recording(recording_url):
    """Twilio recordings need the account's credentials. The file can take a
    moment to become available, so retry briefly."""
    c = config()
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    last_error = None
    for _ in range(6):
        try:
            r = requests.get(recording_url + ".wav", auth=(c["account_sid"], c["auth_token"]), timeout=15)
            if r.status_code == 200 and r.content:
                with open(path, "wb") as f:
                    f.write(r.content)
                return path
            last_error = f"HTTP {r.status_code}"
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(0.5)
    os.remove(path)
    raise RuntimeError(f"Couldn't download the recording ({last_error})")


def _delete_recording(recording_sid):
    """Recordings were only needed to transcribe; don't keep them on Twilio."""
    if not recording_sid:
        return
    try:
        _client().recordings(recording_sid).delete()
    except Exception:
        pass


# ----------------------------------------------------------------- TwiML

def twiml_say_and_listen(audio_filename):
    from twilio.twiml.voice_response import VoiceResponse
    r = VoiceResponse()
    r.play(url(f"/audio/{audio_filename}"))
    r.record(
        action=url("/twilio/heard"),
        method="POST",
        max_length=RECORD_MAX_SECONDS,
        timeout=RECORD_SILENCE_SECONDS,
        play_beep=False,
        trim="trim-silence",
        finish_on_key="#",
    )
    # Twilio skips the action URL when nothing was said and continues here
    r.redirect(url("/twilio/silence"), method="POST")
    return str(r)


def twiml_say_and_hang_up(audio_filename):
    from twilio.twiml.voice_response import VoiceResponse
    r = VoiceResponse()
    r.play(url(f"/audio/{audio_filename}"))
    r.hangup()
    return str(r)


def twiml_wait():
    from twilio.twiml.voice_response import VoiceResponse
    r = VoiceResponse()
    r.pause(length=1)
    r.redirect(url("/twilio/next"), method="POST")
    return str(r)


def twiml_hang_up():
    from twilio.twiml.voice_response import VoiceResponse
    r = VoiceResponse()
    r.hangup()
    return str(r)


# ------------------------------------------------------------- call steps

def on_answer(call_sid, lead_name="there", phone=None):
    """Customer picked up: Ritu's opener, then listen."""
    with _LOCK:
        session = SESSIONS.get(call_sid)
        if not session:  # call started outside this server (e.g. auto_caller.py)
            session = _new_session(call_sid, lead_name, phone)
            SESSIONS[call_sid] = session
        session["status"] = "in-progress"
    audio = _say_to_file(session, pc.opener_text(session["lead_name"]))
    return twiml_say_and_listen(audio)


def _process_turn(session, recording_url, recording_sid):
    """Background: recording -> text -> Ritu's reply -> audio."""
    local = None
    try:
        local = _download_recording(recording_url)
        heard, asr_language = transcribe(local)
        heard = (heard or "").strip()
        _delete_recording(recording_sid)

        if not heard:
            session["pending"] = {"audio": _say_to_file(session, pc.retry_text(session["language"])), "ended": False}
            return

        session["silent_turns"] = 0
        session["transcript"].append({"speaker": "Customer", "text": heard})
        session["outcome"] = pc.detect_outcome(heard, session["outcome"])
        session["language"] = ritu.pick_language(heard, asr_language, session["language"])

        if pc.should_end_call(heard):
            session["pending"] = {"audio": _say_to_file(session, pc.farewell_text(session["language"])), "ended": True}
            return

        reply = ritu.generate_reply(heard, session["history"], session["language"])
        session["history"] = (session["history"] + [
            {"role": "user", "content": heard},
            {"role": "assistant", "content": reply},
        ])[-40:]
        session["pending"] = {"audio": _say_to_file(session, reply), "ended": False}
    except Exception as exc:
        print(f"[twilio] turn failed for {session['call_sid']}: {exc}")
        try:
            session["pending"] = {"audio": _say_to_file(session, pc.retry_text(session["language"])), "ended": False}
        except Exception:
            session["pending"] = {"audio": None, "ended": True}
    finally:
        session["working"] = False
        if local:
            try:
                os.remove(local)
            except OSError:
                pass


def on_recording(call_sid, recording_url, recording_sid=None):
    session = get_session(call_sid)
    if not session or not recording_url:
        return twiml_hang_up()
    session["working"] = True
    session["pending"] = None
    threading.Thread(target=_process_turn, args=(session, recording_url, recording_sid), daemon=True).start()
    return twiml_wait()


def on_next(call_sid):
    """Twilio comes back here while Ritu thinks. Wait a few seconds for her reply."""
    session = get_session(call_sid)
    if not session:
        return twiml_hang_up()
    deadline = time.time() + REPLY_WAIT_SECONDS
    while session["pending"] is None and time.time() < deadline:
        time.sleep(0.15)
    pending = session["pending"]
    if pending is None:
        return twiml_wait()
    session["pending"] = None
    if not pending["audio"]:
        return twiml_hang_up()
    if pending["ended"]:
        return twiml_say_and_hang_up(pending["audio"])
    return twiml_say_and_listen(pending["audio"])


def on_silence(call_sid):
    """The customer said nothing before the recording timed out."""
    session = get_session(call_sid)
    if not session:
        return twiml_hang_up()
    session["silent_turns"] += 1
    if session["silent_turns"] > MAX_SILENT_TURNS:
        return twiml_say_and_hang_up(_say_to_file(session, pc.farewell_text(session["language"])))
    return twiml_say_and_listen(_say_to_file(session, pc.retry_text(session["language"])))


def on_status(call_sid, status, to_number=None):
    """Twilio's call progress: initiated, ringing, in-progress, completed, busy, no-answer, failed."""
    with _LOCK:
        session = SESSIONS.get(call_sid)
        if not session:
            session = _new_session(call_sid, phone=to_number)
            SESSIONS[call_sid] = session
    if status:
        session["status"] = status
    if status in ("completed", "busy", "no-answer", "failed", "canceled"):
        session["ended_at"] = datetime.now(IST).isoformat(timespec="seconds")
        if not session["saved"] and session["transcript"]:
            pc.save_transcript({
                "call_sid": call_sid,
                "lead_name": session["lead_name"] if session["lead_name"] != "there" else None,
                "phone": session["phone"],
                "outcome": session["outcome"],
                "transcript": session["transcript"],
            })
            session["saved"] = True
        _forget_old_sessions()


def _forget_old_sessions(keep_seconds=3600):
    """Keep finished calls around for an hour so the page can show them."""
    cutoff = datetime.now(IST) - timedelta(seconds=keep_seconds)
    with _LOCK:
        for sid in list(SESSIONS):
            ended = SESSIONS[sid].get("ended_at")
            if ended and datetime.fromisoformat(ended) < cutoff:
                SESSIONS.pop(sid, None)


# -------------------------------------------------------------- security

def is_valid_twilio_request(full_url, form, signature):
    """Only Twilio (signing with your auth token) may drive the call webhooks.
    Set TWILIO_SKIP_VALIDATION=1 only while debugging."""
    if os.getenv("TWILIO_SKIP_VALIDATION") == "1":
        return True
    token = config()["auth_token"]
    if not token or not signature:
        return False
    from twilio.request_validator import RequestValidator
    return RequestValidator(token).validate(full_url, form, signature)
