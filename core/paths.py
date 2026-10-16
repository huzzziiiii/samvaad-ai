"""Where Samvaad reads and writes files.

On your laptop or Railway everything lives in data/. On Vercel the project
folder is read-only, so new audio and transcripts go to /tmp (which is wiped
between deployments and isn't shared between servers)."""
import os

ON_VERCEL = bool(os.environ.get("VERCEL"))

BUNDLED_DATA = "data"
WRITE_DATA = os.environ.get("SAMVAAD_DATA_DIR") or ("/tmp/samvaad" if ON_VERCEL else BUNDLED_DATA)

AUDIO_DIR = os.path.join(WRITE_DATA, "audio")
TRANSCRIPT_DIR = os.path.join(WRITE_DATA, "transcripts")
BUNDLED_TRANSCRIPT_DIR = os.path.join(BUNDLED_DATA, "transcripts")
LEADS_CSV = os.path.join(BUNDLED_DATA, "leads.csv")
