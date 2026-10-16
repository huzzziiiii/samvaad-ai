import os
import time
import numpy as np
import soundfile as sf
from sarvamai import SarvamAI
from dotenv import load_dotenv

load_dotenv()

client = SarvamAI(api_subscription_key=os.getenv("SARVAM_API_KEY"))

# VAD Settings
SAMPLERATE = 16000
CHUNK_DURATION = 0.3
CHUNK_SIZE = int(SAMPLERATE * CHUNK_DURATION)
SILENCE_THRESHOLD = 500
SILENCE_TIMEOUT = 1.5
MAX_DURATION = 30
MIN_DURATION = 1.0

# Language Sarvam detected in the last transcription, e.g. "en-IN" or "hi-IN".
last_language = None

def record_audio(filename="customer_input.wav"):
    import sounddevice as sd  # loaded here so the web server runs without audio hardware
    print("\n🎤 Listening... (speak freely, I'll know when you're done)")

    audio_chunks = []
    silence_duration = 0
    total_duration = 0
    speaking_started = False

    with sd.InputStream(samplerate=SAMPLERATE, channels=1, dtype=np.int16) as stream:
        while total_duration < MAX_DURATION:
            chunk, _ = stream.read(CHUNK_SIZE)
            chunk = np.squeeze(chunk)
            audio_chunks.append(chunk)

            volume = np.max(np.abs(chunk))
            total_duration += CHUNK_DURATION

            if volume > SILENCE_THRESHOLD:
                speaking_started = True
                silence_duration = 0
                print(f"   🗣️  Speaking...        ", end="\r")
            else:
                if speaking_started:
                    silence_duration += CHUNK_DURATION
                    print(f"   ⏸️  Silence {silence_duration:.1f}s / {SILENCE_TIMEOUT}s ", end="\r")

                    if silence_duration >= SILENCE_TIMEOUT and total_duration >= MIN_DURATION:
                        print("\n✅ Got it — processing...")
                        break
                else:
                    print(f"   ⏳ Waiting for you to speak...", end="\r")

    if audio_chunks:
        audio_data = np.concatenate(audio_chunks)
        sf.write(filename, audio_data, SAMPLERATE)

        if np.max(np.abs(audio_data)) < SILENCE_THRESHOLD:
            print("⚠️  No sound detected — was your mic on?")
            return None

        return filename

    return None

def transcribe(audio_filename):
    """Speech to text for one audio file. Returns (transcript, language_code).

    Safe to call from several phone calls at once (no shared state).
    "unknown" = auto-detect. With "hi-IN" Sarvam wrote English speech in
    Devanagari, which made Ritu think the customer was speaking Hindi.
    """
    data, _ = sf.read(audio_filename)
    if len(data) == 0 or np.max(np.abs(data)) < 0.001:
        print("⚠️  Audio file is empty")
        return "", None

    with open(audio_filename, "rb") as f:
        response = client.speech_to_text.transcribe(
            file=f,
            model="saaras:v3",
            language_code="unknown"
        )

    transcript = response.transcript or ""
    language = getattr(response, "language_code", None)
    print(f"Customer said: {transcript}  [{language or 'language not detected'}]")
    return transcript, language


def listen(audio_filename=None):
    global last_language
    last_language = None

    if audio_filename is None:
        audio_filename = record_audio()

    if audio_filename is None:
        return ""

    transcript, last_language = transcribe(audio_filename)
    return transcript

if __name__ == "__main__":
    print("Say something — I'll stop when you go quiet...")
    text = listen()
    print(f"\nTranscribed: {text}")