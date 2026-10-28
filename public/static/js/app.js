// Samvaad customer app. All numbers come from the server's loan engine.
(function () {
  "use strict";

  // ------------------------------------------------------------- helpers
  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  function inr(n) { return n == null ? "—" : (n < 0 ? "-₹" : "₹") + fmt.format(Math.abs(Math.round(n))); }
  function months(m) {
    if (m == null) return "never at this EMI";
    var y = Math.floor(m / 12), r = m % 12;
    if (y && r) return y + (y === 1 ? " year " : " years ") + r + (r === 1 ? " month" : " months");
    if (y) return y + (y === 1 ? " year" : " years");
    return r + (r === 1 ? " month" : " months");
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { location.href = "/login?next=/app"; throw new Error("Please sign in again."); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || "Something went wrong. Try again.");
        return d;
      });
    });
  }
  var toastTimer;
  function toast(text) {
    var t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function debounce(fn, ms) {
    var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); };
  }

  // --------------------------------------------------------------- state
  var S = {
    me: null, loans: [], overview: null, profile: {},
    extra: 5000, strategy: "avalanche", savings: null, requests: [], kinds: {},
    chat: [], voice: false
  };

  // ----------------------------------------------------------------- tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".app-tabs .tab"));
  function showTab(name, focus) {
    tabs.forEach(function (t) {
      var on = t.id === "tab-" + name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
      if (on && focus) t.focus();
    });
    if (name === "savings") loadSavings();
    if (name === "requests") loadRequests();
    if (name === "ritu" && !S.chat.length) greet();
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
    window.scrollTo({ top: 0 });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { showTab(t.id.slice(4)); });
    t.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      showTab(n.id.slice(4), true);
      e.preventDefault();
    });
  });
  document.addEventListener("click", function (e) {
    var go = e.target.closest("[data-go]");
    if (go) { showTab(go.dataset.go); if (go.hasAttribute("data-add")) openLoan(null); }
    var close = e.target.closest("[data-close]");
    if (close) close.closest("dialog").close();
  });

  // --------------------------------------------------------- render: top
  function renderHello() {
    var name = (S.profile.name || "").split(" ")[0];
    $("hello").textContent = name ? "Hi " + name : "Your loans";
    var n = S.loans.length;
    $("hello-sub").textContent = n ? n + (n === 1 ? " loan" : " loans") + " added" : "Let's add your loans";
  }

  function renderOverview() {
    var ov = S.overview;
    var has = ov && ov.count > 0;
    $("ov-empty").hidden = has;
    $("ov-body").hidden = !has;
    if (!has) return;
    $("ov-out").textContent = inr(ov.total_outstanding);
    $("ov-emi").textContent = inr(ov.total_emi);
    $("ov-int").textContent = inr(ov.total_interest_left);
    var m = ov.months_to_debt_free, y = Math.floor(m / 12), r = m % 12;
    $("ov-free").textContent = (y ? y + " yr " : "") + (r || !y ? r + " mo" : "");

    var line = $("ov-salary");
    line.textContent = "";
    if (ov.emi_to_salary_pct != null) {
      var pct = ov.emi_to_salary_pct;
      var verdict = pct <= 40 ? "Comfortable. Banks are usually happy below about 50%."
        : pct <= 55 ? "On the high side. Banks get careful around 50% of take-home pay."
        : "High. Most banks will hesitate to lend more until this comes down.";
      line.appendChild(el("strong", null, pct + "% of your salary goes to EMIs. "));
      line.appendChild(document.createTextNode(verdict));
      line.className = "salary-line " + (pct <= 40 ? "is-ok" : pct <= 55 ? "is-wait" : "is-no");
    } else {
      line.className = "salary-line";
      line.appendChild(document.createTextNode("Add your monthly salary to see how heavy your EMIs are and how much more you could borrow. "));
      var b = el("button", "linkish", "Add salary");
      b.type = "button";
      b.addEventListener("click", openProfile);
      line.appendChild(b);
    }
    loadPlan();
  }

  // ---------------------------------------------------------- payoff plan
  var range = $("extra-range");
  function paintExtra() {
    $("extra-out").textContent = inr(S.extra);
    var pct = (S.extra / Number(range.max)) * 100;
    range.style.setProperty("--fill", pct + "%");
  }
  range.addEventListener("input", function () { S.extra = Number(range.value); paintExtra(); loadPlanSoon(); });
  Array.prototype.forEach.call(document.querySelectorAll("[data-strategy]"), function (b) {
    b.addEventListener("click", function () {
      S.strategy = b.dataset.strategy;
      Array.prototype.forEach.call(document.querySelectorAll("[data-strategy]"), function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      loadPlan();
    });
  });

  var planSeq = 0;
  function loadPlan() {
    if (!S.loans.length) return;
    var my = ++planSeq;
    api("GET", "/api/plan?extra=" + S.extra + "&strategy=" + S.strategy).then(function (d) {
      if (my !== planSeq || !d.plan) return;
      renderPlan(d.plan);
    }).catch(function (err) { $("plan-result").textContent = err.message; });
  }
  var loadPlanSoon = debounce(loadPlan, 180);

  function loanLabel(l) {
    var t = (S.me && S.me.loan_types[l.type]) || l.type;
    return l.lender ? t + ", " + l.lender : t;
  }

  function renderPlan(p) {
    var res = $("plan-result");
    res.textContent = "";
    if (!p.extra) {
      res.appendChild(document.createTextNode("Paying as you do now, you're debt-free in "));
      res.appendChild(el("strong", null, months(p.usual_months)));
      res.appendChild(document.createTextNode(" and pay " + inr(p.usual_interest) + " in interest. Move the slider to see what a little extra does."));
    } else {
      res.appendChild(document.createTextNode("Debt-free in "));
      res.appendChild(el("strong", null, months(p.plan_months)));
      res.appendChild(document.createTextNode(" instead of " + months(p.usual_months) + ". You save "));
      res.appendChild(el("strong", "save", inr(p.interest_saved)));
      res.appendChild(document.createTextNode(" in interest."));
    }
    var ol = $("plan-order");
    ol.textContent = "";
    p.order.forEach(function (o, i) {
      var li = el("li");
      li.appendChild(el("span", "tl-step", String(i + 1)));
      var body = el("div", "tl-body");
      body.appendChild(el("p", "tl-name", loanLabel(o) + " (" + o.rate + "%)"));
      var when = "Closes in " + months(o.closes_in_months);
      if (p.extra && o.usual_months && o.closes_in_months < o.usual_months) when += ", " + months(o.usual_months - o.closes_in_months) + " sooner";
      body.appendChild(el("p", "tl-when", when));
      li.appendChild(body);
      ol.appendChild(li);
    });
  }

  // --------------------------------------------------------------- loans
  function renderLoans() {
    var list = $("loan-list");
    list.textContent = "";
    $("loans-empty").hidden = S.loans.length > 0;
    var byId = {};
    (S.overview ? S.overview.loans : []).forEach(function (l) { byId[l.id] = l; });
    S.loans.forEach(function (l) {
      var s = byId[l.id] || {};
      var li = el("li", "loan");
      var head = el("div", "loan-head");
      var title = el("div");
      title.appendChild(el("p", "loan-type", (S.me.loan_types[l.type] || l.type)));
      title.appendChild(el("p", "loan-lender", l.lender || "Lender not added"));
      head.appendChild(title);
      head.appendChild(el("p", "loan-rate", l.rate + "%"));
      li.appendChild(head);
      var dl = el("dl", "loan-facts");
      [["Left", inr(l.outstanding)], ["EMI", inr(l.emi)], ["Closes in", months(s.months_left)], ["Interest left", inr(s.interest_left)]]
        .forEach(function (pair) {
          var d = el("div");
          d.appendChild(el("dt", null, pair[0]));
          d.appendChild(el("dd", null, pair[1]));
          dl.appendChild(d);
        });
      li.appendChild(dl);
      var actions = el("div", "loan-actions");
      var edit = el("button", "btn btn-quiet btn-small", "Edit");
      edit.type = "button";
      edit.addEventListener("click", function () { openLoan(l); });
      var del = el("button", "btn btn-quiet btn-small btn-danger-quiet", "Remove");
      del.type = "button";
      del.addEventListener("click", function () {
        if (!confirm("Remove this " + (S.me.loan_types[l.type] || "loan").toLowerCase() + "?")) return;
        api("DELETE", "/api/loans/" + encodeURIComponent(l.id)).then(function (d) { applyLoans(d); toast("Loan removed."); })
          .catch(function (err) { toast(err.message); });
      });
      actions.appendChild(edit);
      actions.appendChild(del);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function applyLoans(d) {
    S.loans = d.loans || [];
    S.overview = d.overview;
    if (d.profile) S.profile = d.profile;
    S.savings = null;
    renderHello();
    renderOverview();
    renderLoans();
  }

  // loan dialog
  var loanDialog = $("loan-dialog"), loanForm = $("loan-form"), editingId = null;
  function fillTypes(select, types) {
    select.textContent = "";
    Object.keys(types).forEach(function (k) {
      var o = el("option", null, types[k]);
      o.value = k;
      select.appendChild(o);
    });
  }
  $("loan-type").addEventListener("change", function () {
    if (!editingId || loanForm.foreclosure_pct.value === "") {
      loanForm.foreclosure_pct.value = S.me.default_foreclosure[this.value];
    }
  });
  function openLoan(loan) {
    editingId = loan ? loan.id : null;
    $("loan-dialog-title").textContent = loan ? "Edit loan" : "Add a loan";
    $("loan-msg").textContent = "";
    loanForm.type.value = loan ? loan.type : "personal";
    ["lender", "outstanding", "rate", "emi"].forEach(function (k) { loanForm[k].value = loan ? (loan[k] == null ? "" : loan[k]) : ""; });
    loanForm.foreclosure_pct.value = loan ? loan.foreclosure_pct : S.me.default_foreclosure[loanForm.type.value];
    loanDialog.showModal();
    loanForm.outstanding.focus();
  }
  $("add-loan").addEventListener("click", function () { openLoan(null); });
  loanForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {};
    ["type", "lender", "outstanding", "rate", "emi", "foreclosure_pct"].forEach(function (k) { body[k] = loanForm[k].value; });
    $("loan-save").disabled = true;
    api(editingId ? "PUT" : "POST", editingId ? "/api/loans/" + encodeURIComponent(editingId) : "/api/loans", body)
      .then(function (d) {
        applyLoans(d);
        loanDialog.close();
        toast(editingId ? "Loan updated." : "Loan added.");
      })
      .catch(function (err) { $("loan-msg").textContent = err.message; })
      .finally(function () { $("loan-save").disabled = false; });
  });

  // ------------------------------------------------------------- profile
  var profileDialog = $("profile-dialog"), profileForm = $("profile-form");
  function openProfile() {
    ["name", "phone", "salary", "employer", "city"].forEach(function (k) {
      profileForm[k].value = S.profile[k] == null ? "" : S.profile[k];
    });
    $("profile-msg").textContent = "";
    profileDialog.showModal();
  }
  $("edit-profile").addEventListener("click", openProfile);
  profileForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {};
    ["name", "phone", "salary", "employer", "city"].forEach(function (k) { body[k] = profileForm[k].value; });
    api("PUT", "/api/me", body).then(function (d) {
      S.profile = d.profile;
      profileDialog.close();
      toast("Details saved.");
      return api("GET", "/api/loans").then(applyLoans);
    }).catch(function (err) { $("profile-msg").textContent = err.message; });
  });

  // ------------------------------------------------------------- savings
  var flType = $("fl-type");
  flType.addEventListener("change", function () { S.savings = null; loadSavings(); });

  function loadSavings() {
    if (S.savings) return renderSavings();
    $("bt-list").textContent = "Checking lenders…";
    api("GET", "/api/savings?type=" + encodeURIComponent(flType.value || "personal")).then(function (d) {
      S.savings = d;
      renderSavings();
    }).catch(function (err) { $("bt-list").textContent = err.message; });
  }

  function renderSavings() {
    var d = S.savings, box = $("bt-list");
    box.textContent = "";
    if (!S.loans.length) {
      box.appendChild(el("p", "empty-inline", "Add your loans first, then Samvaad checks every lender for you."));
    }
    d.transfers.forEach(function (item) {
      var l = item.loan;
      var block = el("div", "bt");
      var head = el("p", "bt-loan");
      head.appendChild(el("strong", null, loanLabel(l)));
      head.appendChild(document.createTextNode(" at " + l.rate + "%, " + inr(l.outstanding) + " left"));
      block.appendChild(head);
      if (!item.options.length) {
        block.appendChild(el("p", "bt-none", "No lender beats your current rate after fees. Staying put is the right call for now."));
      }
      item.options.forEach(function (o, i) {
        var row = el("div", "bt-offer" + (i === 0 ? " is-best" : ""));
        var left = el("div");
        left.appendChild(el("p", "bt-bank", o.bank + " from " + o.best.rate + "%"));
        left.appendChild(el("p", "bt-detail", "New EMI from " + inr(o.best.new_emi) + " (" + (o.best.emi_change <= 0 ? inr(-o.best.emi_change) + " less" : inr(o.best.emi_change) + " more") +
          "). Fees counted: " + inr(o.processing_fee + o.foreclosure_charge) + "."));
        row.appendChild(left);
        var right = el("div", "bt-save");
        right.appendChild(el("p", "bt-amount", inr(o.best.net_saving)));
        right.appendChild(el("p", "bt-range", o.cautious.net_saving > 0 ? "at least " + inr(o.cautious.net_saving) : "if you get the best rate"));
        row.appendChild(right);
        var go = el("button", "btn btn-primary btn-small", "Get this done");
        go.type = "button";
        go.addEventListener("click", function () {
          openRequest("balance_transfer", { loan_id: l.id, bank_id: o.bank_id },
            "Move your " + (S.me.loan_types[l.type] || "loan").toLowerCase() + (l.lender ? " with " + l.lender : "") + " to " + o.bank +
            ". Estimated saving " + inr(o.best.net_saving) + " after fees.");
        });
        row.appendChild(go);
        block.appendChild(row);
      });
      box.appendChild(block);
    });

    // fresh loan
    if (flType.options.length === 0 || flType.dataset.types !== (d.fresh_types || []).join(",")) {
      var current = flType.value || "personal";
      flType.textContent = "";
      (d.fresh_types.length ? d.fresh_types : ["personal"]).forEach(function (t) {
        var o = el("option", null, S.me.loan_types[t] || t);
        o.value = t;
        flType.appendChild(o);
      });
      flType.dataset.types = (d.fresh_types || []).join(",");
      flType.value = d.fresh_types.indexOf(current) >= 0 ? current : (d.fresh_types[0] || "personal");
    }
    var fb = $("fl-body");
    fb.textContent = "";
    var e = d.eligibility;
    if (!e) {
      var p = el("p", "card-lede", "Add your monthly take-home salary to see how much more you could borrow. ");
      var b = el("button", "linkish", "Add salary");
      b.type = "button";
      b.addEventListener("click", openProfile);
      p.appendChild(b);
      fb.appendChild(p);
      return;
    }
    var lede = el("p", "card-lede");
    lede.appendChild(document.createTextNode("Banks usually keep all your EMIs within about " + e.foir_pct + "% of take-home pay. You pay " +
      inr(e.current_emi) + " now, which leaves room for a new EMI of about "));
    lede.appendChild(el("strong", null, inr(e.emi_room) + " a month"));
    lede.appendChild(document.createTextNode("."));
    fb.appendChild(lede);
    if (!e.emi_room) {
      fb.appendChild(el("p", "bt-none", "Your EMIs are already at the level banks look for, so a new loan is unlikely to be approved. Closing a costly loan first would open up room."));
      return;
    }
    if (!e.offers.length) {
      fb.appendChild(el("p", "bt-none", "No lender for this loan type is set up yet."));
      return;
    }
    e.offers.slice(0, 3).forEach(function (o, i) {
      var row = el("div", "bt-offer" + (i === 0 ? " is-best" : ""));
      var left = el("div");
      left.appendChild(el("p", "bt-bank", o.bank + " from " + o.rate_min + "%"));
      left.appendChild(el("p", "bt-detail", "Over " + months(o.tenure_months) + ", before the bank's credit check."));
      row.appendChild(left);
      var right = el("div", "bt-save");
      right.appendChild(el("p", "bt-amount", "up to " + inr(o.max_amount)));
      row.appendChild(right);
      var go = el("button", "btn btn-primary btn-small", "Get this done");
      go.type = "button";
      go.addEventListener("click", function () {
        openRequest("fresh_loan", { loan_type: e.loan_type, bank_id: o.bank_id },
          "A fresh " + (S.me.loan_types[e.loan_type] || "loan").toLowerCase() + ", up to about " + inr(o.max_amount) + " from " + o.bank + ".", true);
      });
      row.appendChild(go);
      fb.appendChild(row);
    });
  }

  // ------------------------------------------------------------ requests
  var reqDialog = $("req-dialog"), reqForm = $("req-form"), reqPayload = null;
  function openRequest(kind, extra, summary, askAmount) {
    reqPayload = Object.assign({ kind: kind }, extra || {});
    $("req-summary").textContent = summary;
    $("req-amount-field").hidden = !askAmount;
    reqForm.amount.value = "";
    reqForm.phone.value = S.profile.phone || "";
    reqForm.note.value = "";
    $("req-msg").textContent = "";
    reqDialog.showModal();
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-request]"), function (b) {
    b.addEventListener("click", function () {
      openRequest(b.dataset.request, { extra: S.extra },
        "Help following your payoff plan with " + inr(S.extra) + " extra a month.");
    });
  });
  reqForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = Object.assign({}, reqPayload, { phone: reqForm.phone.value, note: reqForm.note.value, amount: reqForm.amount.value });
    $("req-send").disabled = true;
    api("POST", "/api/requests", body).then(function () {
      reqDialog.close();
      S.profile.phone = body.phone;
      toast("Request sent. The Samvaad team will call you.");
      S.requests = null;
      showTab("requests");
    }).catch(function (err) { $("req-msg").textContent = err.message; })
      .finally(function () { $("req-send").disabled = false; });
  });

  var STATUS = { "new": "Received", contacted: "We called you", in_progress: "In progress", done: "Done", closed: "Closed" };
  function loadRequests() {
    api("GET", "/api/requests").then(function (d) {
      S.requests = d.requests;
      S.kinds = d.kinds;
      var list = $("req-list");
      list.textContent = "";
      $("req-empty").hidden = d.requests.length > 0;
      d.requests.forEach(function (r) {
        var li = el("li", "req");
        var head = el("div", "req-head");
        head.appendChild(el("p", "req-kind", d.kinds[r.kind] || r.kind));
        head.appendChild(el("span", "mark req-status req-status--" + r.status, STATUS[r.status] || r.status));
        li.appendChild(head);
        var when = new Date(r.created_at);
        var line = isNaN(when) ? "" : when.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        var det = r.details || {};
        if (r.kind === "balance_transfer" && det.offer) line += ". " + det.offer.bank + ", estimated saving " + inr(det.offer.best.net_saving);
        if (r.kind === "fresh_loan" && det.loan_type) line += ". " + (S.me.loan_types[det.loan_type] || det.loan_type);
        li.appendChild(el("p", "req-line", line));
        list.appendChild(li);
      });
    }).catch(function (err) { toast(err.message); });
  }

  // ------------------------------------------------------------ Ask Ritu
  var log = $("chat-log"), chatForm = $("chat-form"), chatInput = $("chat-input"), sending = false;
  function addChat(role, text, pending) {
    var dt = el("dt", role === "assistant" ? "is-ritu" : null, role === "assistant" ? "Ritu" : "You");
    var dd = el("dd", (role === "assistant" ? "is-ritu" : "") + (pending ? " is-pending" : ""), text);
    if (/[ऀ-ॿ]/.test(text)) dd.lang = "hi";
    log.appendChild(dt);
    log.appendChild(dd);
    dd.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return dd;
  }
  function greet() {
    var n = S.loans.length;
    var text = n
      ? "Hi, I'm Ritu. I can see your " + n + (n === 1 ? " loan" : " loans") + ". Ask me which to close first, whether you can lower your interest, or how much more you could borrow."
      : "Hi, I'm Ritu. Add your loans in the Loans tab and I'll tell you how to close them faster and where you could save.";
    addChat("assistant", text);
  }
  function ask(text) {
    text = (text || "").trim();
    if (!text || sending) return;
    sending = true;
    $("chat-send").disabled = true;
    $("chips").hidden = true;
    addChat("user", text);
    var pending = addChat("assistant", "thinking…", true);
    var voice = $("speak-toggle").checked;
    api("POST", "/api/ritu", { message: text, history: S.chat.slice(-12), voice: voice }).then(function (d) {
      pending.textContent = d.reply;
      pending.classList.remove("is-pending");
      if (/[ऀ-ॿ]/.test(d.reply)) pending.lang = "hi";
      S.chat.push({ role: "user", content: text }, { role: "assistant", content: d.reply });
      if (d.audio) playAudio(d.audio);
    }).catch(function (err) {
      pending.textContent = err.message;
      pending.classList.remove("is-pending");
      pending.classList.add("is-error");
    }).finally(function () {
      sending = false;
      $("chat-send").disabled = false;
      chatInput.focus();
    });
  }
  chatForm.addEventListener("submit", function (e) { e.preventDefault(); var t = chatInput.value; chatInput.value = ""; ask(t); });
  Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (c) {
    c.addEventListener("click", function () { ask(c.textContent); });
  });

  function playAudio(b64) {
    try {
      var bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      var a = new Audio(url);
      a.addEventListener("ended", function () { URL.revokeObjectURL(url); });
      a.play().catch(function () {});
    } catch (e) {}
  }

  // voice question: tap to record, tap again to send
  var mic = $("mic-btn"), rec = null;
  function encodeWav(chunks, rate) {
    var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var data = new Float32Array(total), o = 0;
    chunks.forEach(function (c) { data.set(c, o); o += c.length; });
    var target = 16000, ratio = rate / target, len = Math.floor(data.length / ratio), pcm = new Float32Array(len);
    for (var i = 0; i < len; i++) pcm[i] = data[Math.floor(i * ratio)];
    var buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf);
    function s(off, str) { for (var j = 0; j < str.length; j++) v.setUint8(off + j, str.charCodeAt(j)); }
    s(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); s(8, "WAVE"); s(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, target, true); v.setUint32(28, target * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    s(36, "data"); v.setUint32(40, len * 2, true);
    for (var k = 0, off = 44; k < len; k++, off += 2) {
      var x = Math.max(-1, Math.min(1, pcm[k]));
      v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }
  mic.addEventListener("click", function () {
    if (rec) {
      var r = rec; rec = null;
      mic.classList.remove("is-recording");
      mic.setAttribute("aria-label", "Ask by voice");
      r.proc.disconnect(); r.src.disconnect();
      r.stream.getTracks().forEach(function (t) { t.stop(); });
      var blob = encodeWav(r.chunks, r.ctx.sampleRate);
      r.ctx.close();
      var fd = new FormData();
      fd.append("audio", blob, "question.wav");
      chatInput.placeholder = "Listening to what you said…";
      fetch("/api/ritu/listen", { method: "POST", body: fd }).then(function (res) {
        return res.json().then(function (d) { if (!res.ok) throw new Error(d.error); return d; });
      }).then(function (d) {
        if (d.text) ask(d.text); else toast("Didn't catch that. Try again or type it.");
      }).catch(function (err) { toast(err.message || "Couldn't hear that."); })
        .finally(function () { chatInput.placeholder = "Ask about your loans, in English or Hindi"; });
      return;
    }
    if (!navigator.mediaDevices) { toast("Voice needs a secure (https) page. Type your question instead."); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC(), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1);
      var chunks = [];
      proc.onaudioprocess = function (e) { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(proc); proc.connect(ctx.destination);
      rec = { ctx: ctx, src: src, proc: proc, stream: stream, chunks: chunks };
      mic.classList.add("is-recording");
      mic.setAttribute("aria-label", "Stop and send");
      chatInput.placeholder = "Recording… tap the mic again when you're done";
    }).catch(function () { toast("Microphone blocked. Allow it in the address bar, or type instead."); });
  });

  // ---------------------------------------------------------------- start
  Promise.all([api("GET", "/api/me"), api("GET", "/api/loans")]).then(function (res) {
    S.me = res[0];
    S.profile = res[0].profile || {};
    fillTypes($("loan-type"), S.me.loan_types);
    if (S.me.voice) {
      $("mic-btn").hidden = false;
      $("speak-toggle-wrap").hidden = false;
    }
    applyLoans(res[1]);
    paintExtra();
    var start = (location.hash || "").slice(1);
    if (["overview", "loans", "savings", "ritu", "requests"].indexOf(start) >= 0) showTab(start);
  }).catch(function (err) {
    $("hello-sub").textContent = err.message;
  });
})();
