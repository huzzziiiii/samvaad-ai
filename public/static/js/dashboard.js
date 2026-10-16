(function () {
  "use strict";

  var OUTCOME_LABEL = {
    interested: "Interested",
    callback: "Call back",
    not_interested: "Not interested",
    unknown: "No outcome"
  };
  var OUTCOME_ORDER = ["interested", "callback", "not_interested", "unknown"];
  var OUTCOME_COLOR = {
    interested: "var(--ok)",
    callback: "var(--wait)",
    not_interested: "var(--no)",
    unknown: "var(--none)"
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Calls finished in this browser are also kept on the device (see talk.js),
  // because a Vercel deployment can't keep files between requests.
  function deviceCalls() {
    try { return JSON.parse(localStorage.getItem("samvaad.calls") || "[]") || []; } catch (e) { return []; }
  }

  function merge(serverCalls) {
    var bySid = {};
    serverCalls.forEach(function (c) { if (c.call_sid) bySid[c.call_sid] = true; });
    var extra = deviceCalls().filter(function (c) { return !bySid[c.call_sid]; }).map(function (c) {
      var conv = c.conversation || [];
      c.turns = conv.filter(function (t) { return t.speaker === "Customer"; }).length;
      c.language = conv.some(function (t) { return t.speaker === "Customer" && /[\u0900-\u097F]/.test(t.text || ""); }) ? "Hindi" : "English";
      return c;
    });
    return serverCalls.concat(extra).sort(function (a, b) {
      return (b.timestamp || "").localeCompare(a.timestamp || "");
    });
  }

  var serverCalls = [];
  try { serverCalls = JSON.parse(document.getElementById("calls-data").textContent) || []; } catch (e) { serverCalls = []; }
  var calls = merge(serverCalls);

  var state = {
    outcome: "all",
    query: "",
    selected: (location.hash || "").replace("#", "") || null
  };

  var $list = document.getElementById("calls");
  var $empty = document.getElementById("calls-empty");
  var $nomatch = document.getElementById("calls-nomatch");
  var $viewerEmpty = document.getElementById("viewer-empty");
  var $viewerBody = document.getElementById("viewer-body");

  // ------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function outcomeOf(c) {
    return OUTCOME_LABEL[c.outcome] ? c.outcome : "unknown";
  }

  function mark(outcome) {
    return el("span", "mark mark-" + outcome, OUTCOME_LABEL[outcome]);
  }

  function nameOf(c) {
    if (c.lead_name && c.lead_name !== "there") return c.lead_name;
    if (c.phone) return c.phone;
    return c.call_sid && String(c.call_sid).indexOf("web_") === 0 ? "Browser test call" : "Test call";
  }

  function parseTs(ts) {
    var m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(ts || "");
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  function formatWhen(ts) {
    var d = parseTs(ts);
    if (!d) return ts || "";
    var h = d.getHours(), mm = d.getMinutes();
    var time = ((h % 12) || 12) + ":" + (mm < 10 ? "0" : "") + mm + (h < 12 ? " am" : " pm");
    var today = new Date();
    var yest = new Date(); yest.setDate(today.getDate() - 1);
    var same = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (same(d, today)) return "Today, " + time;
    if (same(d, yest)) return "Yesterday, " + time;
    var day = d.getDate() + " " + MONTHS[d.getMonth()];
    if (d.getFullYear() !== today.getFullYear()) day += " " + d.getFullYear();
    return day + ", " + time;
  }

  function firstCustomerLine(c) {
    var conv = c.conversation || [];
    for (var i = 0; i < conv.length; i++) {
      if (conv[i].speaker === "Customer" && conv[i].text) return conv[i].text;
    }
    return conv.length ? conv[0].text : "";
  }

  function matches(c) {
    if (state.outcome !== "all" && outcomeOf(c) !== state.outcome) return false;
    if (!state.query) return true;
    var q = state.query.toLowerCase();
    if (nameOf(c).toLowerCase().indexOf(q) !== -1) return true;
    if ((c.phone || "").indexOf(q) !== -1) return true;
    var conv = c.conversation || [];
    for (var i = 0; i < conv.length; i++) {
      if ((conv[i].text || "").toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  // -------------------------------------------------------------- render

  function renderStats() {
    var counts = { interested: 0, callback: 0, not_interested: 0, unknown: 0 };
    calls.forEach(function (c) { counts[outcomeOf(c)] += 1; });
    var total = calls.length;
    document.getElementById("stat-total").textContent = total;
    OUTCOME_ORDER.forEach(function (o) {
      document.getElementById("stat-" + o).textContent = counts[o];
    });
    var rate = total ? Math.round((counts.interested / total) * 1000) / 10 : 0;
    document.getElementById("stat-rate").textContent = rate + "%";

    var bar = document.getElementById("tally-bar");
    bar.textContent = "";
    var parts = [];
    OUTCOME_ORDER.forEach(function (o) {
      if (!counts[o]) return;
      var s = el("span");
      s.style.flex = String(counts[o]);
      s.style.background = OUTCOME_COLOR[o];
      bar.appendChild(s);
      parts.push(counts[o] + " " + OUTCOME_LABEL[o].toLowerCase());
    });
    bar.setAttribute("aria-label", total ? "Calls by outcome: " + parts.join(", ") : "No calls yet");
  }

  function renderList() {
    $list.textContent = "";
    var shown = calls.filter(matches);

    $empty.hidden = calls.length !== 0;
    $nomatch.hidden = calls.length === 0 || shown.length !== 0;

    shown.forEach(function (c) {
      var li = el("li");
      var b = el("button", "call");
      b.type = "button";
      b.dataset.id = c.id;
      if (c.id === state.selected) b.setAttribute("aria-current", "true");

      b.appendChild(el("span", "call-name", nameOf(c)));
      b.appendChild(mark(outcomeOf(c)));
      var turns = c.turns || 0;
      b.appendChild(el("span", "call-when",
        formatWhen(c.timestamp) + ", " + turns + " repl" + (turns === 1 ? "y" : "ies") + ", " + (c.language || "English")));
      var snip = firstCustomerLine(c);
      if (snip) b.appendChild(el("span", "call-snippet", "“" + snip + "”"));

      b.addEventListener("click", function () { select(c.id, true); });
      li.appendChild(b);
      $list.appendChild(li);
    });
  }

  function renderViewer() {
    var c = null;
    for (var i = 0; i < calls.length; i++) if (calls[i].id === state.selected) c = calls[i];

    if (!c) {
      $viewerEmpty.hidden = false;
      $viewerBody.hidden = true;
      return;
    }
    $viewerEmpty.hidden = true;
    $viewerBody.hidden = false;

    document.getElementById("v-name").textContent = nameOf(c);
    var meta = [formatWhen(c.timestamp)];
    if (c.phone && c.lead_name) meta.push(c.phone);
    meta.push(c.language || "English");
    if (c.whatsapp_sent_at) meta.push("WhatsApp follow-up sent");
    if (c.on_device) meta.push("saved on this device");
    document.getElementById("v-meta").textContent = meta.join(", ");

    var $o = document.getElementById("v-outcome");
    $o.textContent = "";
    $o.appendChild(mark(outcomeOf(c)));

    var $s = document.getElementById("v-script");
    $s.textContent = "";
    (c.conversation || []).forEach(function (turn) {
      var ritu = turn.speaker === "Ritu";
      var dt = el("dt", ritu ? "is-ritu" : "", ritu ? "Ritu" : "Customer");
      var dd = el("dd", ritu ? "is-ritu" : "", turn.text || "");
      if (/[ऀ-ॿ]/.test(turn.text || "")) dd.lang = "hi";
      $s.appendChild(dt);
      $s.appendChild(dd);
    });
  }

  function select(id, fromClick) {
    state.selected = id;
    if (history.replaceState) history.replaceState(null, "", "#" + id);
    renderList();
    renderViewer();
    if (fromClick && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("viewer").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function renderAll() {
    if (!state.selected && calls.length && window.matchMedia("(min-width: 901px)").matches) {
      state.selected = calls[0].id;
    }
    renderStats();
    renderList();
    renderViewer();
  }

  // ------------------------------------------------------------ controls

  document.getElementById("search").addEventListener("input", function (e) {
    state.query = e.target.value.trim();
    renderList();
  });

  Array.prototype.forEach.call(document.querySelectorAll(".filter"), function (btn) {
    btn.addEventListener("click", function () {
      state.outcome = btn.dataset.outcome;
      Array.prototype.forEach.call(document.querySelectorAll(".filter"), function (b) {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      renderList();
    });
  });

  // tabs
  var tabs = [document.getElementById("tab-calls"), document.getElementById("tab-leads")];
  function showTab(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { showTab(t); });
    t.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        var next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        showTab(next); next.focus(); e.preventDefault();
      }
    });
  });

  // live refresh
  var $note = document.getElementById("refresh-note");
  function refresh() {
    fetch("/api/calls", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        var changed = JSON.stringify(merge(data).map(function (c) { return c.id + c.outcome + (c.conversation || []).length; })) !==
                      JSON.stringify(calls.map(function (c) { return c.id + c.outcome + (c.conversation || []).length; }));
        calls = merge(data);
        if (changed) renderAll();
        $note.textContent = "Updates every 15 seconds.";
      })
      .catch(function () {
        $note.textContent = "Can't reach the server. Showing the last calls loaded; check that app.py is running.";
      });
  }
  setInterval(function () { if (!document.hidden) refresh(); }, 15000);

  renderAll();
})();
