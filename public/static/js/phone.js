// Phone calls: ask the server to ring a number, then follow the call live.
(function () {
  "use strict";

  var OUTCOME_LABEL = {
    interested: "Interested",
    callback: "Call back",
    not_interested: "Not interested",
    unknown: "No outcome"
  };
  var ENDED = { completed: 1, busy: 1, "no-answer": 1, failed: 1, canceled: 1 };
  var STEP_OF = {
    queued: "dialling", initiated: "dialling", ringing: "ringing",
    "in-progress": "talking", answered: "talking"
  };
  var STEPS = ["dialling", "ringing", "talking", "ended"];
  var KEY_STORE = "samvaad.callKey";

  var $card = document.getElementById("phonecard");
  var $form = document.getElementById("dial");
  var $name = document.getElementById("p-name");
  var $phone = document.getElementById("p-phone");
  var $key = document.getElementById("p-key");
  var $callBtn = document.getElementById("p-call");
  var $title = document.getElementById("p-title");
  var $number = document.getElementById("p-number");
  var $status = document.getElementById("p-status");
  var $hint = document.getElementById("p-hint");
  var $clock = document.getElementById("p-clock");
  var $outcome = document.getElementById("p-outcome");
  var $progress = document.getElementById("p-progress");
  var $controls = document.getElementById("p-controls");
  var $hangup = document.getElementById("p-hangup");
  var $ended = document.getElementById("p-ended");
  var $stamp = document.getElementById("p-stamp");
  var $endedLine = document.getElementById("p-ended-line");
  var $again = document.getElementById("p-again");
  var $script = document.getElementById("p-script");
  var $empty = document.getElementById("p-live-empty");

  var callSid = null, pollTimer = null, clockTimer = null, talkStarted = 0, shownLines = 0, misses = 0;
  var defaultHint = $hint.textContent;

  try { $key.value = localStorage.getItem(KEY_STORE) || ""; } catch (e) {}

  // --------------------------------------------------------------- UI bits
  function setStep(step) {
    var idx = STEPS.indexOf(step);
    Array.prototype.forEach.call($progress.children, function (li, i) {
      li.classList.toggle("is-done", i < idx || (step === "ended" && i <= idx));
      li.classList.toggle("is-now", i === idx && step !== "ended");
    });
    $card.dataset.state = step === "talking" ? "ritu" : (step === "ended" ? "ended" : "starting");
  }

  function say(text, hint) {
    $status.textContent = text;
    $hint.textContent = hint || "";
  }

  function showOutcome(o) {
    $outcome.textContent = "";
    if (!o || o === "unknown") return;
    var m = document.createElement("span");
    m.className = "mark mark-" + o;
    m.textContent = OUTCOME_LABEL[o];
    $outcome.appendChild(m);
  }

  function tick() {
    var s = Math.floor((Date.now() - talkStarted) / 1000);
    $clock.textContent = (s < 600 ? "0" : "") + Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function renderTranscript(lines, thinking) {
    // drop a previous "thinking" placeholder
    var pending = $script.querySelector(".is-pending");
    if (pending) { pending.previousElementSibling.remove(); pending.remove(); }

    for (var i = shownLines; i < lines.length; i++) {
      var ritu = lines[i].speaker === "Ritu";
      var dt = document.createElement("dt");
      dt.textContent = ritu ? "Ritu" : "Customer";
      if (ritu) dt.className = "is-ritu";
      var dd = document.createElement("dd");
      dd.textContent = lines[i].text;
      if (ritu) dd.className = "is-ritu";
      if (/[ऀ-ॿ]/.test(lines[i].text)) dd.lang = "hi";
      $script.appendChild(dt);
      $script.appendChild(dd);
    }
    shownLines = lines.length;
    if (lines.length) $empty.hidden = true;

    if (thinking) {
      var pdt = document.createElement("dt");
      pdt.className = "is-ritu";
      pdt.textContent = "Ritu";
      var pdd = document.createElement("dd");
      pdd.className = "is-ritu is-pending";
      pdd.textContent = "thinking…";
      $script.appendChild(pdt);
      $script.appendChild(pdd);
    }
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { "X-Access-Key": $key.value } };
    if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var err = new Error(data.error || ("Server error " + r.status)); err.status = r.status; throw err; }
        return data;
      });
    });
  }

  // ------------------------------------------------------------- polling
  function poll() {
    if (!callSid) return;
    api("GET", "/api/phone/calls/" + encodeURIComponent(callSid)).then(function (v) {
      misses = 0;
      var step = ENDED[v.status] ? "ended" : (STEP_OF[v.status] || "dialling");
      setStep(step);
      showOutcome(v.outcome);
      renderTranscript(v.transcript || [], v.thinking && step === "talking");

      if (step === "talking" && !talkStarted) {
        talkStarted = Date.now();
        tick();
        clockTimer = setInterval(tick, 1000);
      }

      if (step === "dialling") say("Calling " + v.phone + "…", "Twilio is connecting the call.");
      else if (step === "ringing") say("Ringing…", "Waiting for " + (v.lead_name !== "there" ? v.lead_name : "the customer") + " to pick up.");
      else if (step === "talking") {
        var last = (v.transcript || [])[v.transcript.length - 1];
        if (v.thinking) say("Ritu is thinking…", "The customer just finished speaking.");
        else if (last && last.speaker === "Ritu") say("Ritu is speaking, then listening.", "Speaking " + v.language + ".");
        else say("On the call.", "");
      } else {
        finish(v);
      }
    }).catch(function (err) {
      misses += 1;
      if (err.status === 404 || misses > 8) {
        finish({ status: "completed", outcome: "unknown", transcript: [] }, "Lost track of this call. The server may have restarted; check the call log.");
      }
    });
  }

  function finish(v, note) {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    callSid = null;
    $controls.hidden = true;
    $callBtn.disabled = false;

    var messages = {
      busy: "The line was busy.",
      "no-answer": "No one picked up.",
      failed: "The call didn't go through.",
      canceled: "The call was cancelled."
    };
    var spoke = (v.transcript || []).some(function (t) { return t.speaker === "Customer"; });
    say(messages[v.status] || "Call ended.", note || "");

    $stamp.textContent = "";
    if (v.status === "completed" && spoke) {
      var s = document.createElement("span");
      s.className = "stamp is-" + (OUTCOME_LABEL[v.outcome] ? v.outcome : "unknown");
      s.textContent = OUTCOME_LABEL[v.outcome] || "No outcome";
      $stamp.appendChild(s);
    }
    $endedLine.textContent = spoke ? "Saved to the call log." : (v.status === "completed" ? "The customer didn't say anything." : "");
    $ended.hidden = false;
  }

  // ------------------------------------------------------------- actions
  $form.addEventListener("submit", function (e) {
    e.preventDefault();
    if ($callBtn.disabled) return;
    try { localStorage.setItem(KEY_STORE, $key.value); } catch (err) {}

    $callBtn.disabled = true;
    $script.textContent = "";
    $empty.hidden = false;
    shownLines = 0; misses = 0; talkStarted = 0;
    $clock.textContent = "00:00";
    $ended.hidden = true;
    showOutcome(null);
    $title.textContent = "Ritu is calling " + ($name.value.trim() || "the customer");
    $number.textContent = $phone.value.trim();
    setStep("dialling");
    say("Placing the call…", "");

    api("POST", "/api/phone/call", { name: $name.value, phone: $phone.value, key: $key.value }).then(function (res) {
      callSid = res.call_sid;
      $form.hidden = true;
      $controls.hidden = false;
      poll();
      pollTimer = setInterval(poll, 1500);
    }).catch(function (err) {
      $callBtn.disabled = false;
      setStep(null);
      $card.dataset.state = "error";
      say("Couldn't place the call.", err.message);
    });
  });

  $hangup.addEventListener("click", function () {
    if (!callSid) return;
    $hangup.disabled = true;
    api("POST", "/api/phone/calls/" + encodeURIComponent(callSid) + "/hangup").catch(function (err) {
      say("Couldn't hang up.", err.message);
    }).then(function () { $hangup.disabled = false; });
  });

  $again.addEventListener("click", function () {
    $ended.hidden = true;
    $form.hidden = false;
    $title.textContent = "Ritu will call";
    $number.textContent = "Enter a name and number";
    $clock.textContent = "00:00";
    setStep(null);
    $card.dataset.state = "idle";
    say("Ready to call.", defaultHint);
    $phone.focus();
  });
})();
