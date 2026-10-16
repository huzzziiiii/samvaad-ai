import os
import json
import re
import requests
from datetime import datetime

from core.speak import speak
from core import listen as listen_mod
from core.listen import listen
from core import respond as respond_mod
from core.respond import respond, reset_conversation

from core.paths import AUDIO_DIR, TRANSCRIPT_DIR

# Checked in this order: a clear "no" beats everything, then "call me later",
# then real interest. Words like "okay", "yes" or "haan" are NOT interest on their
# own — customers say them to be polite.
OUTCOME_PHRASES = [
    ("not_interested", [
        "not interested", "no interest", "no thanks", "no thank you", "don't want",
        "dont want", "do not want", "don't need", "dont need", "not looking",
        "don't call", "dont call", "stop calling", "remove my number",
        "nahi chahiye", "nahin chahiye", "zarurat nahi", "zaroorat nahi", "interest nahi",
        "mat karo", "mat karna", "dobara mat", "nahi chalega", "nahin chalega",
        "नहीं चाहिए", "जरूरत नहीं", "ज़रूरत नहीं", "इंटरेस्ट नहीं", "नॉट इंटरेस्टेड", "मत करो",
    ]),
    ("callback", [
        "call later", "call me later", "call back", "callback", "call tomorrow",
        "call me tomorrow", "busy right now", "i'm busy", "im busy", "i am busy",
        "in a meeting", "driving", "not a good time", "some other time",
        "baad mein", "baad me", "kal call", "kal karo", "abhi busy", "abhi nahi",
        "बाद में", "कल कॉल", "अभी बिज़ी", "अभी बिजी", "बिज़ी हूँ", "बिजी हूं",
    ]),
    ("interested", [
        "interested", "tell me more", "send details", "send me details", "send the details",
        "how much can i get", "what's the rate", "what is the rate", "what's the interest",
        "sounds good", "let's do it", "lets do it", "go ahead", "i'll send", "i will send",
        "payslip", "salary slip", "send it on whatsapp", "whatsapp me",
        "kitna milega", "kitna mil sakta", "details bhejo", "bhej dunga", "bhej deta",
        "chalega", "karwa do", "process karo", "apply karna",
        "इंटरेस्टेड", "कितना मिलेगा", "कितना मिल सकता", "भेज दूंगा", "भेज देता", "पेस्लिप", "सैलरी स्लिप",
    ]),
]

END_PHRASES = [
    "bye", "goodbye", "end call", "hang up", "disconnect",
    "band karo", "rakhdo", "phone rakh", "nahi chahiye baat",
    "don't call again", "dont call again", "dobara mat karna", "cut the call",
    "बाय", "फोन रखो", "फ़ोन रखो", "कॉल कट",
]


def _has_phrase(text: str, phrase: str) -> bool:
    # whole-word match so "no" doesn't fire inside "know" and
    # "interested" doesn't fire inside "not interested" (checked first anyway)
    return re.search(r"(?<![\w\u0900-\u097f])" + re.escape(phrase) + r"(?![\w\u0900-\u097f])", text) is not None


def ensure_dirs():
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)


def public_base_url():
    return (os.getenv("EXOTEL_CALLBACK_BASE_URL") or "").rstrip("/")


def audio_public_url(filename: str) -> str:
    base = public_base_url()
    if not base:
        return f"/audio/{filename}"
    return f"{base}/audio/{filename}"


def detect_outcome(text: str, current: str) -> str:
    text_lower = (text or "").lower().replace("’", "'")
    for outcome, phrases in OUTCOME_PHRASES:
        if outcome == "interested" and any(_has_phrase(text_lower, n) for n in ("not interested", "no interest")):
            continue
        if any(_has_phrase(text_lower, p) for p in phrases):
            return outcome
    return current


def should_end_call(text: str) -> bool:
    text_lower = (text or "").lower().replace("’", "'")
    return any(_has_phrase(text_lower, p) for p in END_PHRASES)


def _in_hindi() -> bool:
    return respond_mod.detected_language == "hi-IN"


def retry_text(language: str = "en-IN") -> str:
    if language == "hi-IN":
        return "Maaf kijiye, awaaz saaf nahi aayi. Ek baar phir bolenge?"
    return "Sorry, I didn't quite catch that. Could you say it once more?"


def farewell_text(language: str = "en-IN") -> str:
    if language == "hi-IN":
        return "Aapke samay ke liye dhanyavaad! Kabhi bhi loan ki zaroorat ho toh zaroor yaad kijiyega. Aapka din shubh ho!"
    return ("Thank you so much for your time. If you ever need help with a loan, "
            "do get in touch. Have a lovely day!")


def save_transcript(session: dict):
    ensure_dirs()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = os.path.join(TRANSCRIPT_DIR, f"call_{timestamp}_{str(session.get('call_sid') or '')[-6:]}.json".replace("_.json", ".json"))
    data = {
        "timestamp": timestamp,
        "outcome": session.get("outcome", "unknown"),
        "conversation": session.get("transcript", []),
        "call_sid": session.get("call_sid"),
    }
    if session.get("lead_name"):
        data["lead_name"] = session["lead_name"]
    if session.get("phone"):
        data["phone"] = session["phone"]
    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return filename


def opener_text(lead_name: str = "there") -> str:
    greeting = lead_name if lead_name and lead_name != "there" else "there"
    return (
        f"Hello {greeting}! I'm Ritu from the loan advisory team. "
        f"I wanted to quickly share a great option for a personal loan or balance transfer — "
        f"do you have just two minutes?"
    )


def start_session(call_sid: str, lead_name="there", phone=None):
    reset_conversation()
    ensure_dirs()
    text = opener_text(lead_name)
    wav_name = f"{call_sid}_turn_0.wav"
    speak(text, filename=os.path.join(AUDIO_DIR, wav_name))
    session = {
        "call_sid": call_sid,
        "lead_name": lead_name,
        "phone": phone,
        "turn": 0,
        "outcome": "unknown",
        "transcript": [{"speaker": "Ritu", "text": text}],
        "last_audio": wav_name,
        "ended": False,
    }
    return session


def transcribe_recording_url(recording_url: str) -> str:
    if not recording_url:
        return ""
    auth = None
    sid = os.getenv("EXOTEL_SID")
    token = os.getenv("EXOTEL_TOKEN")
    if sid and token:
        auth = (sid, token)
    response = requests.get(recording_url, auth=auth, timeout=60)
    response.raise_for_status()
    ensure_dirs()
    local_path = os.path.join(AUDIO_DIR, f"rec_{datetime.now().strftime('%H%M%S%f')}.wav")
    with open(local_path, "wb") as f:
        f.write(response.content)
    return listen(audio_filename=local_path)


def last_asr_language():
    """Language Sarvam detected in the most recent transcription."""
    return listen_mod.last_language


def retry_listen_prompt(session, call_sid):
    retry = retry_text("hi-IN" if _in_hindi() else "en-IN")
    session["transcript"].append({"speaker": "Ritu", "text": retry})
    turn = session["turn"] + 1
    wav_name = f"{call_sid}_turn_{turn}.wav"
    speak(retry, filename=os.path.join(AUDIO_DIR, wav_name), language_code="hi-IN" if _in_hindi() else "en-IN")
    session["last_audio"] = wav_name
    session["turn"] = turn
    return session


def process_customer_turn(session: dict, customer_text: str, asr_language=None) -> dict:
    session["transcript"].append({"speaker": "Customer", "text": customer_text})
    session["outcome"] = detect_outcome(customer_text, session["outcome"])

    if should_end_call(customer_text):
        farewell = farewell_text("hi-IN" if _in_hindi() else "en-IN")
        session["transcript"].append({"speaker": "Ritu", "text": farewell})
        turn = session["turn"] + 1
        wav_name = f"{session['call_sid']}_turn_{turn}.wav"
        speak(farewell, filename=os.path.join(AUDIO_DIR, wav_name), language_code="hi-IN" if _in_hindi() else "en-IN")
        session["last_audio"] = wav_name
        session["turn"] = turn
        session["ended"] = True
        return session

    turn = session["turn"] + 1
    wav_name = f"{session['call_sid']}_turn_{turn}.wav"
    reply_text, _ = respond(customer_text, audio_out=os.path.join(AUDIO_DIR, wav_name), asr_language=asr_language)
    session["transcript"].append({"speaker": "Ritu", "text": reply_text})
    session["last_audio"] = wav_name
    session["turn"] = turn
    return session


def exoml_play_and_record(play_url: str, record_callback: str, max_length: int = 30) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>{play_url}</Play>
  <Record maxLength="{max_length}" finishOnKey="#" recordingCallbackUrl="{record_callback}" />
</Response>"""


def exoml_play_only(play_url: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>{play_url}</Play>
  <Hangup/>
</Response>"""


def exoml_say_and_record(text: str, record_callback: str) -> str:
    safe = re.sub(r"[<&>\"']", " ", text)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>{safe}</Say>
  <Record maxLength="30" finishOnKey="#" recordingCallbackUrl="{record_callback}" />
</Response>"""
