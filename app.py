import os
import csv
import json
import uuid
import base64
import tempfile
from datetime import datetime

from flask import Flask, render_template, jsonify, request, Response, send_from_directory
from dotenv import load_dotenv

load_dotenv()

from core import phone_call as pc
from core import respond as ritu
from core import twilio_call as tw
from core.speak import speak_bytes
from core.paths import AUDIO_DIR, TRANSCRIPT_DIR, BUNDLED_TRANSCRIPT_DIR, LEADS_CSV

# Static files live in public/static: Vercel serves public/ from its CDN at the
# same /static/... URLs, and Flask serves them the same way locally.
app = Flask(__name__, static_folder="public/static", static_url_path="/static")

EXOTEL_SESSIONS = {}

MAX_HISTORY = 40        # messages of context sent back to the model
MAX_LINE = 1500         # characters per message kept in call state


# ---------------------------------------------------------------- data helpers

def has_devanagari(text):
    return any("ऀ" <= ch <= "ॿ" for ch in text or "")


def call_language(conversation):
    customer_lines = [t.get("text", "") for t in conversation if t.get("speaker") == "Customer"]
    if not customer_lines:
        return "English"
    return "Hindi" if any(has_devanagari(t) for t in customer_lines) else "English"


def get_transcripts():
    transcripts = []
    seen = set()
    for folder in (TRANSCRIPT_DIR, BUNDLED_TRANSCRIPT_DIR):
        if not os.path.isdir(folder):
            continue
        for filename in os.listdir(folder):
            if not filename.endswith(".json") or filename in seen:
                continue
            seen.add(filename)
            try:
                with open(os.path.join(folder, filename), "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
            conversation = data.get("conversation", [])
            data["id"] = filename[:-5]
            data["turns"] = sum(1 for t in conversation if t.get("speaker") == "Customer")
            data["language"] = call_language(conversation)
            transcripts.append(data)

    transcripts.sort(key=lambda t: (t.get("timestamp") or "", t["id"]), reverse=True)
    return transcripts


def get_stats(transcripts):
    total = len(transcripts)
    interested = sum(1 for t in transcripts if t.get("outcome") == "interested")
    not_interested = sum(1 for t in transcripts if t.get("outcome") == "not_interested")
    callback = sum(1 for t in transcripts if t.get("outcome") == "callback")
    unknown = total - interested - not_interested - callback

    return {
        "total": total,
        "interested": interested,
        "not_interested": not_interested,
        "callback": callback,
        "unknown": unknown,
        "conversion_rate": round((interested / total * 100), 1) if total > 0 else 0,
    }


def get_leads():
    if not os.path.exists(LEADS_CSV):
        return []
    with open(LEADS_CSV, newline="", encoding="utf-8") as f:
        return [row for row in csv.DictReader(f)]


# ---------------------------------------------------------------------- pages

@app.route("/")
def landing():
    stats = get_stats(get_transcripts())
    return render_template("index.html", stats=stats, active="home")


@app.route("/dashboard")
def dashboard():
    transcripts = get_transcripts()
    return render_template(
        "dashboard.html",
        calls=transcripts,
        stats=get_stats(transcripts),
        leads=get_leads(),
        active="dashboard",
    )


@app.route("/talk")
def talk():
    return render_template("talk.html", active="talk")


@app.route("/phone")
def phone():
    return render_template(
        "phone.html",
        active="phone",
        setup=tw.setup_status(),
        prefill_name=request.args.get("name", "")[:60],
        prefill_phone=request.args.get("phone", "")[:20],
    )


# ------------------------------------------------------------------ JSON API

@app.route("/api/stats")
def api_stats():
    return jsonify(get_stats(get_transcripts()))


@app.route("/api/calls")
def api_calls():
    return jsonify(get_transcripts())


@app.route("/api/leads")
def api_leads():
    return jsonify(get_leads())


@app.route("/audio/<path:filename>")
def serve_audio(filename):
    return send_from_directory(AUDIO_DIR, filename)


# ------------------------------------------------ browser call ("Talk to Ritu")
#
# The browser keeps the call state and sends it back every turn, so any server
# (or any Vercel instance) can answer. Ritu's audio comes back inline as base64.

def _audio_payload(text, language):
    wav = speak_bytes(text, language_code=language)
    return base64.b64encode(wav).decode("ascii")


def _read_state():
    raw = request.form.get("state")
    if raw is None:
        payload = request.get_json(silent=True) or {}
        state = payload.get("state")
    else:
        try:
            state = json.loads(raw)
        except ValueError:
            state = None
    if not isinstance(state, dict) or not isinstance(state.get("transcript"), list):
        return None

    def clean_lines(lines, keys):
        out = []
        for item in lines[-200:]:
            if isinstance(item, dict) and all(isinstance(item.get(k), str) for k in keys):
                out.append({k: item[k][:MAX_LINE] for k in keys})
        return out

    language = state.get("language") if state.get("language") in ("en-IN", "hi-IN") else "en-IN"
    outcome = state.get("outcome") if state.get("outcome") in ("interested", "not_interested", "callback", "unknown") else "unknown"
    return {
        "call_id": str(state.get("call_id") or ("web_" + uuid.uuid4().hex[:10]))[:40],
        "lead_name": str(state.get("lead_name") or "there")[:60],
        "language": language,
        "outcome": outcome,
        "history": [m for m in clean_lines(state.get("history") or [], ("role", "content"))
                    if m["role"] in ("user", "assistant")][-MAX_HISTORY:],
        "transcript": clean_lines(state["transcript"], ("speaker", "text")),
        "started_at": str(state.get("started_at") or "")[:30],
    }


def _ritu_says(state, text, ended=False, heard=None):
    state["transcript"].append({"speaker": "Ritu", "text": text})
    return jsonify({
        "state": state,
        "heard": heard,
        "reply": text,
        "audio": _audio_payload(text, state["language"]),
        "outcome": state["outcome"],
        "ended": ended,
    })


@app.route("/api/talk/start", methods=["POST"])
def talk_start():
    try:
        payload = request.get_json(silent=True) or {}
        lead_name = (payload.get("name") or "").strip()[:60] or "there"
        state = {
            "call_id": "web_" + uuid.uuid4().hex[:10],
            "lead_name": lead_name,
            "language": "en-IN",
            "outcome": "unknown",
            "history": [],
            "transcript": [],
            "started_at": datetime.now().isoformat(timespec="seconds"),
        }
        return _ritu_says(state, pc.opener_text(lead_name))
    except Exception as exc:
        app.logger.exception("talk_start failed")
        return jsonify({"error": f"Couldn't start the call: {exc}"}), 500


@app.route("/api/talk/turn", methods=["POST"])
def talk_turn():
    state = _read_state()
    if state is None:
        return jsonify({"error": "This call has ended. Start a new call."}), 400
    try:
        heard, asr_language = "", None
        audio_file = request.files.get("audio")
        if audio_file:
            fd, in_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            try:
                audio_file.save(in_path)
                heard = pc.listen(audio_filename=in_path) or ""
                asr_language = pc.last_asr_language()
            finally:
                try:
                    os.remove(in_path)
                except OSError:
                    pass
        else:
            payload = request.get_json(silent=True) or {}
            heard = (request.form.get("text") or payload.get("text") or "").strip()
        heard = heard.strip()[:MAX_LINE]

        if not heard:
            return _ritu_says(state, pc.retry_text(state["language"]), heard="")

        state["transcript"].append({"speaker": "Customer", "text": heard})
        state["outcome"] = pc.detect_outcome(heard, state["outcome"])
        state["language"] = ritu.pick_language(heard, asr_language, state["language"])

        if pc.should_end_call(heard):
            return _ritu_says(state, pc.farewell_text(state["language"]), ended=True, heard=heard)

        reply = ritu.generate_reply(heard, state["history"], state["language"])
        state["history"] = (state["history"] + [
            {"role": "user", "content": heard},
            {"role": "assistant", "content": reply},
        ])[-MAX_HISTORY:]
        return _ritu_says(state, reply, heard=heard)
    except Exception as exc:
        app.logger.exception("talk_turn failed")
        return jsonify({"error": f"Ritu couldn't answer that: {exc}"}), 500


@app.route("/api/talk/end", methods=["POST"])
def talk_end():
    state = _read_state()
    if state is None:
        return jsonify({"saved": False, "outcome": "unknown"})
    saved = False
    if len(state["transcript"]) > 1:
        try:
            pc.save_transcript({
                "call_sid": state["call_id"],
                "lead_name": state["lead_name"] if state["lead_name"] != "there" else None,
                "outcome": state["outcome"],
                "transcript": state["transcript"],
            })
            saved = True
        except OSError:
            app.logger.exception("couldn't save transcript")
    return jsonify({"saved": saved, "outcome": state["outcome"]})


# ------------------------------------------------------ real phone calls (Twilio)

def _access_key():
    payload = request.get_json(silent=True) or {}
    return request.headers.get("X-Access-Key") or payload.get("key") or ""


@app.route("/api/phone/setup")
def phone_setup():
    return jsonify(tw.setup_status())


@app.route("/api/phone/call", methods=["POST"])
def phone_call_start():
    setup = tw.setup_status()
    if not setup["ready"]:
        return jsonify({"error": "Phone calls aren't set up yet. Missing: " + ", ".join(setup["missing"]) + "."}), 503
    if not tw.check_access_key(_access_key()):
        return jsonify({"error": "Wrong access key. It's the CALL_ACCESS_KEY in your .env file."}), 403
    if not tw.within_calling_hours():
        return jsonify({"error": f"Sales calls in India are only allowed between {setup['hours'].replace('-', ':00 and ')}:00. "
                                 "For testing with your own number, set CALL_HOURS=0-24 in .env."}), 403
    payload = request.get_json(silent=True) or {}
    try:
        call_sid = tw.start_call(payload.get("phone", ""), payload.get("name", ""))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        # Twilio explains trial limits, unverified numbers and blocked countries clearly
        message = getattr(exc, "msg", None) or str(exc)
        app.logger.warning("Twilio call failed: %s", message)
        return jsonify({"error": f"Twilio couldn't place the call: {message}"}), 502
    return jsonify({"call_sid": call_sid})


@app.route("/api/phone/calls/<call_sid>")
def phone_call_view(call_sid):
    if not tw.check_access_key(_access_key()):
        return jsonify({"error": "Wrong access key."}), 403
    view = tw.public_view(tw.get_session(call_sid))
    if not view:
        return jsonify({"error": "This call isn't on this server any more."}), 404
    return jsonify(view)


@app.route("/api/phone/calls/<call_sid>/hangup", methods=["POST"])
def phone_call_hangup(call_sid):
    if not tw.check_access_key(_access_key()):
        return jsonify({"error": "Wrong access key."}), 403
    try:
        tw.hang_up(call_sid)
    except Exception as exc:
        return jsonify({"error": f"Couldn't hang up: {getattr(exc, 'msg', None) or exc}"}), 502
    return jsonify({"ok": True})


def _twiml(body):
    return Response(body, mimetype="text/xml")


@app.before_request
def _check_twilio_signature():
    if not request.path.startswith("/twilio/"):
        return None
    full_url = tw.config()["base_url"] + request.full_path.rstrip("?")
    if not tw.is_valid_twilio_request(full_url, request.form.to_dict(), request.headers.get("X-Twilio-Signature", "")):
        app.logger.warning("Rejected unsigned request to %s (check PUBLIC_BASE_URL matches your public link)", request.path)
        return Response("Forbidden", status=403)
    return None


@app.route("/twilio/voice", methods=["POST"])
def twilio_voice():
    return _twiml(tw.on_answer(request.form.get("CallSid", ""),
                               lead_name=request.args.get("name") or "there",
                               phone=request.form.get("To")))


@app.route("/twilio/heard", methods=["POST"])
def twilio_heard():
    return _twiml(tw.on_recording(request.form.get("CallSid", ""),
                                  request.form.get("RecordingUrl", ""),
                                  request.form.get("RecordingSid")))


@app.route("/twilio/next", methods=["POST"])
def twilio_next():
    return _twiml(tw.on_next(request.form.get("CallSid", "")))


@app.route("/twilio/silence", methods=["POST"])
def twilio_silence():
    return _twiml(tw.on_silence(request.form.get("CallSid", "")))


@app.route("/twilio/status", methods=["POST"])
def twilio_status():
    tw.on_status(request.form.get("CallSid", ""), request.form.get("CallStatus", ""), request.form.get("To"))
    return "", 204


# -------------------------------------------------------------- Exotel hooks

@app.route("/exotel/voice", methods=["GET", "POST"])
def exotel_voice():
    call_sid = request.values.get("CallSid") or request.values.get("call_sid") or "unknown"
    lead_name = request.values.get("name") or "there"
    phone = request.values.get("From") or request.values.get("CallFrom")

    session = pc.start_session(call_sid, lead_name=lead_name, phone=phone)
    EXOTEL_SESSIONS[call_sid] = session

    play_url = pc.audio_public_url(session["last_audio"])
    record_url = f"{pc.public_base_url()}/exotel/recording?CallSid={call_sid}"
    body = pc.exoml_play_and_record(play_url, record_url)
    return Response(body, mimetype="application/xml")


@app.route("/exotel/recording", methods=["GET", "POST"])
def exotel_recording():
    call_sid = request.values.get("CallSid") or request.values.get("call_sid") or "unknown"
    recording_url = request.values.get("RecordingUrl") or request.values.get("recording_url")

    session = EXOTEL_SESSIONS.get(call_sid)
    if not session:
        session = pc.start_session(call_sid)
        EXOTEL_SESSIONS[call_sid] = session

    asr_language = None
    try:
        customer_text = pc.transcribe_recording_url(recording_url)
        asr_language = pc.last_asr_language()
    except Exception as exc:
        app.logger.warning("Recording transcribe failed: %s", exc)
        customer_text = ""

    if not customer_text or not customer_text.strip():
        session = pc.retry_listen_prompt(session, call_sid)
        EXOTEL_SESSIONS[call_sid] = session
        play_url = pc.audio_public_url(session["last_audio"])
        record_url = f"{pc.public_base_url()}/exotel/recording?CallSid={call_sid}"
        return Response(pc.exoml_play_and_record(play_url, record_url), mimetype="application/xml")

    session = pc.process_customer_turn(session, customer_text, asr_language=asr_language)
    EXOTEL_SESSIONS[call_sid] = session

    if session.get("ended"):
        pc.save_transcript(session)
        play_url = pc.audio_public_url(session["last_audio"])
        return Response(pc.exoml_play_only(play_url), mimetype="application/xml")

    play_url = pc.audio_public_url(session["last_audio"])
    record_url = f"{pc.public_base_url()}/exotel/recording?CallSid={call_sid}"
    return Response(pc.exoml_play_and_record(play_url, record_url), mimetype="application/xml")


@app.route("/exotel/status", methods=["GET", "POST"])
def exotel_status():
    app.logger.info("Exotel status: %s", dict(request.values))
    return "", 204


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes")
    app.run(host="0.0.0.0", port=port, debug=debug)
