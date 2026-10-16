import os
import sys
import time
import json
from datetime import datetime
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.speak import speak
from core import listen as listen_mod
from core.listen import listen, record_audio
from core import respond as respond_mod
from core.respond import respond, reset_conversation
from core.phone_call import detect_outcome, should_end_call

def save_transcript(transcript_log, outcome="unknown", lead_name=None, phone=None):
    os.makedirs("data/transcripts", exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"data/transcripts/call_{timestamp}.json"

    data = {
        "timestamp": timestamp,
        "outcome": outcome,
        "conversation": transcript_log
    }
    if lead_name:
        data["lead_name"] = lead_name
    if phone:
        data["phone"] = phone

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n📝 Transcript saved: {filename}")
    return filename

def play_audio(filename):
    os.startfile(os.path.abspath(filename))
    # wait for the whole reply, so the mic doesn't record Ritu talking
    try:
        import soundfile as sf
        duration = sf.info(filename).duration
    except Exception:
        duration = 4
    time.sleep(duration + 0.6)


def lang_code():
    return "hi-IN" if respond_mod.detected_language == "hi-IN" else "en-IN"


def retry_line():
    if lang_code() == "hi-IN":
        return "Maaf kijiye, awaaz saaf nahi aayi. Ek baar phir bolenge?"
    return "Sorry, I didn't quite catch that. Could you say it once more?"

def run_conversation(lead_name="there", phone=None):
    reset_conversation()
    print("=" * 50)
    print("   SAMVAAD AI — Ritu Loan Advisor")
    print("=" * 50)
    print("Press ENTER to start the call...")
    input()

    transcript_log = []
    outcome = "unknown"

    greeting = lead_name if lead_name and lead_name != "there" else "there"
    opener = (
        f"Hello {greeting}! I'm Ritu from the loan advisory team. "
        f"I wanted to quickly share a great option for a personal loan or balance transfer — "
        f"do you have just two minutes?"
    )

    print(f"\nRitu: {opener}")
    transcript_log.append({"speaker": "Ritu", "text": opener})
    speak(opener, filename="turn_0.wav")
    play_audio("turn_0.wav")

    turn = 1

    while True:
        print("\n" + "─" * 40)

        # Record customer voice
        audio_file = record_audio(filename=f"customer_{turn}.wav")

        if audio_file is None:
            print("⚠️  Didn't catch that — Ritu will prompt again...")
            retry = retry_line()
            transcript_log.append({"speaker": "Ritu", "text": retry})
            speak(retry, filename=f"turn_{turn}.wav", language_code=lang_code())
            play_audio(f"turn_{turn}.wav")
            continue

        # Transcribe
        customer_text = listen(audio_filename=audio_file)

        if not customer_text or customer_text.strip() == "":
            print("⚠️  Couldn't transcribe — Ritu will prompt again...")
            retry = retry_line()
            transcript_log.append({"speaker": "Ritu", "text": retry})
            speak(retry, filename=f"turn_{turn}.wav", language_code=lang_code())
            play_audio(f"turn_{turn}.wav")
            continue

        print(f"\nYou said: {customer_text}")
        transcript_log.append({"speaker": "Customer", "text": customer_text})

        # Detect outcome (shared rules in core/phone_call.py)
        outcome = detect_outcome(customer_text, outcome)
        asr_language = listen_mod.last_language

        # Check for call end
        if should_end_call(customer_text):
            if lang_code() == "hi-IN":
                farewell = "Aapke samay ke liye dhanyavaad! Kabhi bhi loan ki zaroorat ho toh zaroor yaad kijiyega. Aapka din shubh ho!"
            else:
                farewell = "Thank you so much for your time. If you ever need help with a loan, do get in touch. Have a lovely day!"
            print(f"\nRitu: {farewell}")
            transcript_log.append({"speaker": "Ritu", "text": farewell})
            speak(farewell, filename=f"turn_{turn}.wav", language_code=lang_code())
            play_audio(f"turn_{turn}.wav")
            save_transcript(transcript_log, outcome=outcome, lead_name=lead_name, phone=phone)
            print("\n" + "=" * 50)
            print(f"Call ended. Outcome: {outcome}")
            print("=" * 50)
            break

        # Ritu responds
        print("\n💭 Ritu is thinking...")
        reply_text, reply_audio = respond(
            customer_text,
            audio_out=f"turn_{turn}.wav",
            asr_language=asr_language
        )
        transcript_log.append({"speaker": "Ritu", "text": reply_text})
        play_audio(reply_audio)

        turn += 1

        # Save after every 5 turns as backup
        if turn % 5 == 0:
            save_transcript(transcript_log, outcome=outcome, lead_name=lead_name, phone=phone)

if __name__ == "__main__":
    run_conversation()