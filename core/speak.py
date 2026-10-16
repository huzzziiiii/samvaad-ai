import os
import base64
from sarvamai import SarvamAI
from sarvamai.play import save
from dotenv import load_dotenv

load_dotenv()

client = SarvamAI(api_subscription_key=os.getenv("SARVAM_API_KEY"))

def speak(text, filename="output.wav", language_code="en-IN"):
    # en-IN reads English and numbers in English ("fifty thousand").
    # hi-IN reads them in Hindi ("pachaas hazaar") — only use it for Hindi replies.
    response = client.text_to_speech.convert(
        text=text,
        language_code=language_code,
        model="bulbul:v3",
        speaker="ritu"
    )
    save(response, filename)
    print(f"Audio saved: {filename}")
    return filename

def speak_bytes(text, language_code="en-IN"):
    """Same voice, returned as WAV bytes (for the web call, which can't rely on saved files)."""
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        speak(text, filename=path, language_code=language_code)
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


if __name__ == "__main__":
    speak("Namaste Rahul ji, main aapko personal loan ke baare mein baat karna chahti thi. Kya aap 2 minute de sakte hain?", language_code="hi-IN")