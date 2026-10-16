// Talk to Ritu — a full voice call in the browser.
// Flow: start -> Ritu speaks opener -> listen (VAD) -> send WAV -> Ritu replies -> listen ...
// The VAD mirrors core/listen.py: wait for speech, stop after ~1.4s of silence.
(function () {
  "use strict";

  var SILENCE_AFTER_SPEECH = 1.4;  // seconds of quiet that ends a turn
  var MAX_TURN = 25;               // seconds, hard cap per turn
  var MIN_SPEECH = 0.35;           // seconds of speech before we treat it as a turn
  var PREROLL = 0.35;              // seconds kept before speech starts
  var NUDGE_AFTER = 10;            // seconds of nothing before we show a hint
  var TARGET_RATE = 16000;

  var OUTCOME_LABEL = {
    interested: "Interested",
    callback: "Call back",
    not_interested: "Not interested",
    unknown: "No outcome"
  };

  // ---------------------------------------------------------------- DOM
  var $card = document.getElementById("callcard");
  var $status = document.getElementById("status");
  var $hint = document.getElementById("status-hint");
  var $clock = document.getElementById("clock");
  var $setup = document.getElementById("setup");
  var $controls = document.getElementById("controls");
  var $done = document.getElementById("btn-done");
  var $typeBtn = document.getElementById("btn-type");
  var $typebox = document.getElementById("typebox");
  var $typeInput = document.getElementById("type-input");
  var $end = document.getElementById("btn-end");
  var $ended = document.getElementById("ended");
  var $endedStamp = document.getElementById("ended-stamp");
  var $endedLine = document.getElementById("ended-line");
  var $again = document.getElementById("btn-again");
  var $script = document.getElementById("live-script");
  var $liveEmpty = document.getElementById("live-empty");
  var $liveOutcome = document.getElementById("live-outcome");
  var $canvas = document.getElementById("wave");

  // -------------------------------------------------------------- state
  var ctx = null, micStream = null, micSource = null, micAnalyser = null, processor = null, sink = null;
  var playAnalyser = null, currentAudio = null;
  var callState = null, outcome = "unknown"; // callState travels to the server every turn
  var state = "idle";
  var startedAt = 0, clockTimer = null;
  var rec = null; // current listening turn
  var turnSeq = 0; // guards against an older turn resuming after a newer one started

  // ------------------------------------------------------------- UI bits
  function setState(next, text, hint) {
    state = next;
    $card.dataset.state = next;
    if (text != null) $status.textContent = text;
    $hint.textContent = hint || "";
    $done.disabled = next !== "listening";
  }

  function addLine(speaker, text, pending) {
    $liveEmpty.hidden = true;
    var ritu = speaker === "Ritu";
    var dt = document.createElement("dt");
    dt.textContent = ritu ? "Ritu" : "You";
    if (ritu) dt.className = "is-ritu";
    var dd = document.createElement("dd");
    dd.textContent = text;
    dd.className = (ritu ? "is-ritu" : "") + (pending ? " is-pending" : "");
    if (/[ऀ-ॿ]/.test(text)) dd.lang = "hi";
    $script.appendChild(dt);
    $script.appendChild(dd);
    dd.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return dd;
  }

  function showOutcome(o) {
    outcome = OUTCOME_LABEL[o] ? o : "unknown";
    $liveOutcome.textContent = "";
    if (outcome === "unknown") return;
    var m = document.createElement("span");
    m.className = "mark mark-" + outcome;
    m.textContent = OUTCOME_LABEL[outcome];
    $liveOutcome.appendChild(m);
  }

  function tickClock() {
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    $clock.textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  // --------------------------------------------------------- visualizer
  var g = $canvas.getContext("2d");
  var BARS = 44;
  var bins = null;
  var levels = new Array(BARS).fill(0);
  var css = getComputedStyle(document.documentElement);
  var COLORS = {
    ritu: css.getPropertyValue("--marigold").trim() || "#d9952b",
    listening: css.getPropertyValue("--stamp").trim() || "#2e3d9e",
    idle: "rgba(30,34,53,0.22)"
  };

  function fitCanvas() {
    var r = $canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    $canvas.width = Math.max(1, Math.round(r.width * dpr));
    $canvas.height = Math.max(1, Math.round(r.height * dpr));
  }
  window.addEventListener("resize", fitCanvas);
  fitCanvas();

  function draw(now) {
    var analyser = state === "ritu" ? playAnalyser : (state === "listening" ? micAnalyser : null);
    if (analyser) {
      if (!bins || bins.length !== analyser.frequencyBinCount) bins = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins);
    }
    var w = $canvas.width, h = $canvas.height;
    g.clearRect(0, 0, w, h);
    var gap = w / BARS;
    var bw = Math.max(2, gap * 0.42);
    var color = state === "ritu" ? COLORS.ritu : state === "listening" ? COLORS.listening : COLORS.idle;
    g.fillStyle = color;

    for (var i = 0; i < BARS; i++) {
      var target;
      if (analyser) {
        // fold speech-band bins symmetrically so the shape is centred
        var mid = (BARS - 1) / 2;
        var dist = Math.abs(i - mid) / mid;
        var idx = Math.floor(2 + dist * 60);
        target = (bins[idx] || 0) / 255;
        target = Math.pow(target, 1.4);
      } else if (state === "thinking" || state === "starting") {
        target = 0.12 + 0.1 * Math.sin(now / 260 + i * 0.45);
      } else {
        target = 0.02;
      }
      levels[i] += (target - levels[i]) * 0.28;
      var bh = Math.max(bw, levels[i] * h * 0.92);
      var x = i * gap + (gap - bw) / 2;
      var y = (h - bh) / 2;
      roundRect(x, y, bw, bh, bw / 2);
    }
    requestAnimationFrame(draw);
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
    g.fill();
  }
  requestAnimationFrame(draw);

  // -------------------------------------------------------------- audio
  function ensureAudio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      playAnalyser = ctx.createAnalyser();
      playAnalyser.fftSize = 256;
      playAnalyser.smoothingTimeConstant = 0.6;
      playAnalyser.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    if (micStream) return Promise.resolve();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("This browser can't use the microphone here. Open the page on localhost or https, or use Type instead."));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    }).then(function (stream) {
      micStream = stream;
      micSource = ctx.createMediaStreamSource(stream);
      micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = 0.55;
      micSource.connect(micAnalyser);

      processor = ctx.createScriptProcessor(4096, 1, 1);
      sink = ctx.createGain();
      sink.gain.value = 0;
      micSource.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);
      processor.onaudioprocess = onMicBuffer;
    });
  }

  function releaseMic() {
    if (processor) { processor.onaudioprocess = null; try { processor.disconnect(); } catch (e) {} }
    if (micSource) { try { micSource.disconnect(); } catch (e) {} }
    if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
    micStream = micSource = micAnalyser = processor = sink = null;
  }

  // Ritu's audio arrives as base64 WAV; play it from a blob: URL (same-origin,
  // so the visualizer can read it).
  function playRitu(b64) {
    return new Promise(function (resolve) {
      if (!b64) return resolve();
      var url;
      try {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      } catch (e) { return resolve(); }
      var a = new Audio();
      a.src = url;
      currentAudio = a;
      try {
        var src = ctx.createMediaElementSource(a);
        src.connect(playAnalyser);
      } catch (e) { /* visualizer is optional */ }
      var done = function () { if (currentAudio === a) currentAudio = null; URL.revokeObjectURL(url); resolve(); };
      a.addEventListener("ended", done);
      a.addEventListener("error", done);
      var p = a.play();
      if (p && p.catch) p.catch(done);
    });
  }

  function stopRitu() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.dispatchEvent(new Event("ended"));
    }
  }

  // ---------------------------------------------------------------- VAD
  function startListening() {
    if (!callState) return;
    rec = {
      chunks: [],
      samples: 0,
      rate: ctx.sampleRate,
      startedAt: performance.now(),
      floor: 0, floorN: 0,
      speechAt: -1,       // sample index where speech began
      speechSamples: 0,
      quiet: 0,           // seconds of quiet since speech began
      nudged: false
    };
    setState("listening", "Listening…", "Talk normally. Ritu answers when you pause.");
  }

  function onMicBuffer(e) {
    if (state !== "listening" || !rec) return;
    var data = e.inputBuffer.getChannelData(0);
    var copy = new Float32Array(data);
    rec.chunks.push(copy);

    var sum = 0;
    for (var i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
    var rms = Math.sqrt(sum / copy.length);
    var dur = copy.length / rec.rate;
    var elapsed = rec.samples / rec.rate;

    // learn the room's noise floor for the first 0.4s
    if (elapsed < 0.4 && rec.speechAt < 0) {
      rec.floor = (rec.floor * rec.floorN + rms) / (rec.floorN + 1);
      rec.floorN += 1;
    }
    var threshold = Math.max(0.012, rec.floor * 2.6);

    if (rms > threshold) {
      if (rec.speechAt < 0) rec.speechAt = rec.samples;
      rec.speechSamples += copy.length;
      rec.quiet = 0;
    } else if (rec.speechAt >= 0) {
      rec.quiet += dur;
    }
    rec.samples += copy.length;
    elapsed += dur;

    var spoke = rec.speechSamples / rec.rate >= MIN_SPEECH;
    if (spoke && rec.quiet >= SILENCE_AFTER_SPEECH) return finishTurn();
    if (elapsed >= MAX_TURN) return finishTurn();

    if (!rec.nudged && rec.speechAt < 0 && elapsed > NUDGE_AFTER) {
      rec.nudged = true;
      $hint.textContent = "Not hearing anything. Check your mic, or use Type instead.";
    }
  }

  function finishTurn() {
    if (state !== "listening" || !rec) return;
    var r = rec;
    rec = null;
    var spoke = r.speechSamples / r.rate >= MIN_SPEECH;
    if (!spoke) {
      // nothing usable — keep listening rather than sending silence
      startListening();
      $hint.textContent = "Didn't catch that. Try again a little louder.";
      return;
    }
    var all = concat(r.chunks, r.samples);
    var from = Math.max(0, r.speechAt - Math.floor(PREROLL * r.rate));
    var trimmed = all.subarray(from);
    var wav = encodeWav(downsample(trimmed, r.rate, TARGET_RATE), TARGET_RATE);
    sendTurn({ audio: wav });
  }

  function concat(chunks, total) {
    var out = new Float32Array(total);
    var o = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }

  function downsample(buf, from, to) {
    if (from === to) return buf;
    var ratio = from / to;
    var len = Math.floor(buf.length / ratio);
    var out = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      var start = Math.floor(i * ratio), end = Math.min(buf.length, Math.floor((i + 1) * ratio));
      var s = 0;
      for (var j = start; j < end; j++) s += buf[j];
      out[i] = s / Math.max(1, end - start);
    }
    return out;
  }

  function encodeWav(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var v = new DataView(buffer);
    function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (var i = 0, o = 44; i < samples.length; i++, o += 2) {
      var x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  // ---------------------------------------------------------------- API
  function api(path, body) {
    var opts = { method: "POST" };
    if (body instanceof FormData) opts.body = body;
    else { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body || {}); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ("Server error " + r.status));
        return data;
      });
    });
  }

  function sendTurn(input) {
    var my = ++turnSeq;
    setState("thinking", "Ritu is thinking…");
    var pendingYou = input.text ? null : addLine("You", "…", true);
    if (input.text) addLine("You", input.text);

    var body;
    if (input.audio) {
      body = new FormData();
      body.append("state", JSON.stringify(callState));
      body.append("audio", input.audio, "turn.wav");
    } else {
      body = { state: callState, text: input.text };
    }

    api("/api/talk/turn", body).then(function (res) {
      if (my !== turnSeq || !callState) return;
      callState = res.state;
      if (pendingYou) {
        if (res.heard) { pendingYou.textContent = res.heard; pendingYou.classList.remove("is-pending"); if (/[ऀ-ॿ]/.test(res.heard)) pendingYou.lang = "hi"; }
        else { pendingYou.textContent = "(not clear)"; }
      }
      showOutcome(res.outcome);
      return speak(res.reply, res.audio).then(function () {
        if (my !== turnSeq) return;
        if (res.ended) finishCall(true);
        else if (callState) startListening();
      });
    }).catch(function (err) {
      if (pendingYou) { pendingYou.textContent = "(not sent)"; }
      setState("error", "That turn didn't go through.", err.message + " Speak again, or type instead.");
      setTimeout(function () { if (my === turnSeq && state === "error" && callState) startListening(); }, 2500);
    });
  }

  function speak(text, url) {
    if (text) addLine("Ritu", text);
    setState("ritu", "Ritu is speaking…", "She'll listen as soon as she finishes.");
    return playRitu(url);
  }

  // Keep finished calls on this device too, so the call log shows them even
  // when the server can't keep files (Vercel).
  var DEVICE_KEY = "samvaad.calls";
  function saveOnDevice(st) {
    if (!st || !st.transcript || st.transcript.length < 2) return;
    try {
      var list = JSON.parse(localStorage.getItem(DEVICE_KEY) || "[]");
      var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
      var ts = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      list = list.filter(function (c) { return c.call_sid !== st.call_id; });
      list.unshift({
        id: "device_" + st.call_id,
        call_sid: st.call_id,
        timestamp: ts,
        outcome: st.outcome || "unknown",
        lead_name: st.lead_name && st.lead_name !== "there" ? st.lead_name : undefined,
        conversation: st.transcript,
        on_device: true
      });
      localStorage.setItem(DEVICE_KEY, JSON.stringify(list.slice(0, 50)));
    } catch (e) { /* storage blocked — the server copy is the fallback */ }
  }

  // --------------------------------------------------------------- call
  var startSeq = 0;
  function startCall(e) {
    if (e) e.preventDefault();
    setState("starting", "Connecting…", "Allow the microphone if your browser asks.");
    $setup.hidden = true;
    $ended.hidden = true;
    $script.textContent = "";
    $liveEmpty.hidden = false;
    showOutcome("unknown");

    ensureAudio().catch(function (err) {
      // no mic — the call still works by typing
      $typebox.hidden = false;
      $typeBtn.setAttribute("aria-expanded", "true");
      $typeBtn.hidden = true;
      $hint.textContent = (err && err.name === "NotAllowedError")
        ? "Microphone blocked, so this call is typed. Allow the mic in the address bar to talk."
        : (err.message || "No microphone found, so this call is typed.");
    }).then(function () {
      return api("/api/talk/start", { name: document.getElementById("lead-name").value });
    }).then(function (res) {
      callState = res.state;
      startSeq = ++turnSeq;
      startedAt = Date.now();
      tickClock();
      clockTimer = setInterval(tickClock, 1000);
      $controls.hidden = false;
      return speak(res.reply, res.audio);
    }).then(function () {
      if (!callState || startSeq !== turnSeq) return;
      if (micStream) startListening();
      else setState("listening", "Your turn.", "Type what the customer says.");
    }).catch(function (err) {
      callState = null;
      $setup.hidden = false;
      $controls.hidden = true;
      setState("error", "Couldn't start the call.", err.message + " Check that SARVAM_API_KEY is set and app.py is running.");
    });
  }

  function finishCall(ritued) {
    turnSeq += 1;
    var final = callState;
    callState = null;
    rec = null;
    stopRitu();
    clearInterval(clockTimer);
    $controls.hidden = true;
    $typebox.hidden = true;
    $typeBtn.hidden = false;
    $typeBtn.setAttribute("aria-expanded", "false");
    releaseMic();

    setState("ended", ritued ? "Ritu ended the call." : "Call ended.");
    var stamp = document.createElement("span");
    stamp.className = "stamp is-" + outcome;
    stamp.textContent = OUTCOME_LABEL[outcome];
    $endedStamp.textContent = "";
    $endedStamp.appendChild(stamp);
    $endedLine.textContent = "Saving the transcript…";
    $ended.hidden = false;

    if (!final) return;
    saveOnDevice(final);
    api("/api/talk/end", { state: final }).then(function (res) {
      $endedLine.textContent = res.saved
        ? "Saved to the call log with this outcome."
        : "Nothing was said, so there was nothing to save.";
    }).catch(function () {
      $endedLine.textContent = "Kept on this device. The server couldn't save it.";
    });
  }

  // ------------------------------------------------------------- wiring
  $setup.addEventListener("submit", startCall);
  $again.addEventListener("click", function () { $ended.hidden = true; $setup.hidden = false; setState("idle", "Ready when you are."); $clock.textContent = "00:00"; });
  $end.addEventListener("click", function () { finishCall(false); });
  $done.addEventListener("click", function () {
    if (!rec) return;
    if (rec.speechSamples === 0) { $hint.textContent = "Say something first."; return; }
    finishTurn();
  });

  $typeBtn.addEventListener("click", function () {
    var open = $typebox.hidden;
    $typebox.hidden = !open;
    $typeBtn.setAttribute("aria-expanded", String(open));
    if (open) $typeInput.focus();
  });

  $typebox.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = $typeInput.value.trim();
    if (!text || !callState || state === "thinking") return;
    $typeInput.value = "";
    rec = null;
    stopRitu();
    sendTurn({ text: text });
  });

  window.addEventListener("beforeunload", function () {
    if (callState && navigator.sendBeacon) {
      saveOnDevice(callState);
      navigator.sendBeacon("/api/talk/end", new Blob([JSON.stringify({ state: callState })], { type: "application/json" }));
    }
  });
})();
