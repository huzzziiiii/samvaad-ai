(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var CFG = JSON.parse($("cfg").textContent);

  // Samvaad's support number (digits with 91). Set SUPPORT_PHONE on the server.
  var SUPPORT_PHONE = CFG.support_phone || "910000000000";

  var fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  function inr(n) { return "₹" + fmt.format(Math.round(Number(n) || 0)); }
  function pct(x) { return (Math.round(Number(x) * 100) / 100) + "%"; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function monthsText(n) { n = Math.round(n || 0); var y = Math.floor(n / 12), m = n % 12; return (y ? y + " yr" : "") + (y && m ? " " : "") + (m || !y ? m + " mo" : ""); }
  function when(iso) {
    var d = new Date(iso); if (isNaN(d)) return "";
    var today = new Date(), y = new Date(Date.now() - 864e5);
    var t = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }).toLowerCase();
    if (d.toDateString() === today.toDateString()) return "Today, " + t;
    if (d.toDateString() === y.toDateString()) return "Yesterday, " + t;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + ", " + t;
  }
  function niceDate(iso) {
    var d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  var toastTimer;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function busy(btn, on) { if (btn) btn.classList.toggle("is-busy", !!on); }

  // ---- talking to the Samvaad server
  function api(method, path, body) {
    var o = { method: method, headers: {}, credentials: "same-origin" };
    if (body instanceof FormData) o.body = body;
    else if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && !/^\/auth\//.test(path)) { goLogin(); }
        if (!r.ok) { var e = new Error(d.error || "Something went wrong. Try again."); e.data = d; e.status = r.status; throw e; }
        return d;
      });
    }, function () { throw new Error("You're offline. Check your internet and try again."); });
  }

  // ---- simple screen switching
  var history_ = ["screen-id"];
  function show(id) {
    document.querySelectorAll("[data-screen]").forEach(function (s) { s.hidden = s.id !== id; });
    if (history_[history_.length - 1] !== id) history_.push(id);
  }
  document.querySelectorAll("[data-back]").forEach(function (b) {
    b.addEventListener("click", function () {
      history_.pop();
      var prev = history_[history_.length - 1] || "screen-home";
      if (prev === "screen-home") backHome();
      else if (prev === "screen-admin" && window.SamvaadAdmin) window.SamvaadAdmin.back();
      else show(prev);
    });
  });

  // =================================================================== sign in
  var sb = null;
  if (CFG.mode === "supabase" && window.supabase) {
    // detectSessionInUrl is off: the reset link is handled below, so it also
    // works when the customer opens the email on another phone or in Gmail.
    sb = window.supabase.createClient(CFG.supabase_url, CFG.supabase_anon_key, { auth: { persistSession: true, flowType: "pkce", detectSessionInUrl: false } });
  }
  function goLogin() {
    D = null;
    $("pass-input").value = "";
    history_ = ["screen-id"]; show("screen-id"); window.scrollTo(0, 0);
  }

  var userId = "";
  $("id-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("id-input").value.trim();
    var digits = v.replace(/[\s-]/g, "");
    var isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    var isPhone = /^(\+91)?[6-9]\d{9}$/.test(digits);
    if (isPhone) { $("id-err").textContent = "Phone sign-in is coming soon. For now, please use your email."; return; }
    if (!isEmail) { $("id-err").textContent = "Enter a valid email address."; return; }
    $("id-err").textContent = "";
    userId = v.toLowerCase();
    setNew(false);
    $("pass-who").textContent = userId;
    show("screen-pass");
    $("pass-input").focus();
  });

  var creating = false;
  function setNew(on) {
    creating = on;
    $("pass-title").textContent = on ? "Create your account" : "Welcome back";
    $("name-wrap").hidden = !on;
    $("pass-hint").hidden = !on;
    $("forgot").hidden = on;
    $("pass-input").autocomplete = on ? "new-password" : "current-password";
    $("pass-input").placeholder = on ? "Create a password" : "Password";
    $("pass-btn").textContent = on ? "Create account" : "Log in";
    $("switch-new").textContent = on ? "Already have an account? Log in" : "New here? Create an account";
    $("pass-err").textContent = "";
  }
  $("switch-new").addEventListener("click", function () { setNew(!creating); });
  $("show-pass").addEventListener("click", function () {
    var p = $("pass-input");
    p.type = p.type === "password" ? "text" : "password";
    this.textContent = p.type === "password" ? "Show" : "Hide";
  });

  function startSession(body) {
    return api("POST", "/auth/session", body).then(function () { return loadHome(); }).then(landing);
  }

  $("pass-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("pass-input").value, name = $("name-input").value.trim();
    if (pw.length < 8) { $("pass-err").textContent = "Password must be at least 8 characters."; return; }
    if (creating && !name) { $("pass-err").textContent = "Enter your name."; $("name-input").focus(); return; }
    $("pass-err").textContent = "";
    var btn = $("pass-btn"); busy(btn, true);
    var p;
    if (!sb) {                                   // local test mode on your laptop
      p = startSession({ email: userId, name: name });
    } else {
      p = (creating
        ? sb.auth.signUp({ email: userId, password: pw, options: { data: { full_name: name } } })
        : sb.auth.signInWithPassword({ email: userId, password: pw })
      ).then(function (res) {
        if (res.error) {
          var m = res.error.message || "";
          if (/invalid login/i.test(m)) throw new Error("That email and password don't match. New here? Create an account.");
          if (/already registered/i.test(m)) throw new Error("You already have an account. Log in instead.");
          throw new Error(m || "Couldn't sign you in.");
        }
        var s = res.data && res.data.session;
        if (!s) throw new Error("Check your email for a confirmation link, then log in here.");
        return startSession({ access_token: s.access_token, name: name });
      });
    }
    p.catch(function (err) { $("pass-err").textContent = err.message; }).finally(function () { busy(btn, false); });
  });

  // ------------------------------------------------------ forgot password
  // Talks to Supabase Auth directly (no PKCE), so the link in the email works
  // on any phone or browser, not only the one that asked for it.
  function authFetch(method, path, body, token) {
    var h = { "Content-Type": "application/json", apikey: CFG.supabase_anon_key };
    if (token) h.Authorization = "Bearer " + token;
    return fetch(CFG.supabase_url.replace(/\/$/, "") + "/auth/v1" + path, { method: method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.msg || d.error_description || d.message || "Something went wrong. Try again."); e.status = r.status; e.code = d.error_code || d.code; throw e; }
        return d;
      }); });
  }

  var lastReset = 0;
  $("forgot").addEventListener("click", function () {
    var btn = this;
    if (!sb) { $("pass-err").textContent = "Password reset works on the live app."; return; }
    if (Date.now() - lastReset < 60000) { $("pass-err").textContent = "We've just sent it. Check your inbox and spam folder."; return; }
    $("pass-err").textContent = ""; busy(btn, true);
    authFetch("POST", "/recover?redirect_to=" + encodeURIComponent(location.origin + "/app"), { email: userId }).then(function () {
      lastReset = Date.now();
      $("pass-err").textContent = "";
      toast("We've emailed a reset link to " + userId + ". Check your spam folder too.");
    }).catch(function (err) {
      $("pass-err").textContent = err.status === 429 || /rate limit/i.test(err.message)
        ? "Too many reset emails. Wait a few minutes and try again, or tap Call us."
        : (err.message || "Couldn't send the reset email.");
    }).finally(function () { busy(btn, false); });
  });

  $("np-show").addEventListener("click", function () {
    var t = $("np-input").type === "password" ? "text" : "password";
    $("np-input").type = t; $("np-again").type = t;
    this.textContent = t === "password" ? "Show" : "Hide";
  });

  // coming back from the reset email: /app#access_token=...&type=recovery
  function handleRecovery() {
    var hash = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    if (!hash.get("type") && !hash.get("error_code")) return Promise.resolve(false);
    history.replaceState(null, "", "/app");
    if (hash.get("error_code") || hash.get("error")) {
      goLogin();
      $("id-err").textContent = /expired|invalid/i.test(hash.get("error_description") || hash.get("error_code") || "")
        ? "That reset link has expired. Enter your email and tap Forgot password again."
        : "That link didn't work. Enter your email and try again.";
      return Promise.resolve(true);
    }
    var token = hash.get("access_token");
    if (hash.get("type") !== "recovery" || !token || !sb) return Promise.resolve(false);
    return authFetch("GET", "/user", null, token).then(function (u) {
      $("np-who").textContent = u.email || "";
      history_ = ["screen-newpass"]; show("screen-newpass"); $("np-input").focus();
      $("np-form").onsubmit = function (e) {
        e.preventDefault();
        var pw = $("np-input").value;
        if (pw.length < 8) { $("np-err").textContent = "Password must be at least 8 characters."; return; }
        if (pw !== $("np-again").value) { $("np-err").textContent = "The two passwords don't match."; return; }
        $("np-err").textContent = "";
        var btn = $("np-btn"); busy(btn, true);
        authFetch("PUT", "/user", { password: pw }, token).then(function () {
          return sb.auth.signInWithPassword({ email: u.email, password: pw });
        }).then(function (res) {
          var s = res && res.data && res.data.session;
          toast("Password changed.");
          return startSession({ access_token: s ? s.access_token : token });
        }).catch(function (err) {
          $("np-err").textContent = /same|different from the old/i.test(err.message || "")
            ? "Choose a password different from your old one."
            : /weak|pwned|leaked/i.test(err.message || "") ? "That password is too easy to guess. Try a longer one."
            : (err.message || "Couldn't save the password. Try again.");
        }).finally(function () { busy(btn, false); });
      };
      return true;
    }).catch(function () {
      goLogin();
      $("id-err").textContent = "That reset link has expired. Enter your email and tap Forgot password again.";
      return true;
    });
  }

  // ====================================================================== data
  var D = null;          // everything from /api/home
  var TYPE_NAMES = {};
  var APP_NAME = { balance_transfer: "Lower my rate", fresh_loan: "New loan", payoff_help: "Close faster", callback: "Call me" };

  function typeName(t) { return TYPE_NAMES[t] || "Loan"; }

  function loadHome() {
    return api("GET", "/api/home").then(function (d) {
      D = d; TYPE_NAMES = d.loan_types || TYPE_NAMES;
      paintHome();
      return d;
    });
  }

  function bestSaving() {
    var best = null;
    (D.transfers || []).forEach(function (t) {
      var o = t.options && t.options[0];
      if (o && (!best || o.best.net_saving > best.o.best.net_saving)) best = { t: t, o: o };
    });
    return best;
  }

  function requestText(r) {
    var d = r.details || {};
    if (r.kind === "balance_transfer" && d.loan) return typeName(d.loan.type) + " to " + ((d.offer && d.offer.bank) || "a cheaper bank");
    if (r.kind === "fresh_loan") return typeName(d.loan_type) + (d.amount_wanted ? " of " + d.amount_wanted : "");
    if (r.kind === "payoff_help" && d.plan) return inr(d.plan.extra) + " extra a month";
    if (r.kind === "callback") return (d.call_time || "Any time") + (d.topic ? " · " + d.topic : "");
    return "";
  }
  function activityItems() {
    return (D.requests || []).map(function (r) {
      var line = requestText(r);
      return { title: APP_NAME[r.kind] || r.kind, meta: (line ? line + " · " : "") + when(r.created_at), status: r.status,
               kind: r.kind, text: (APP_NAME[r.kind] || r.kind) + (line ? " · " + line : ""), when: when(r.created_at) };
    });
  }

  // ====================================================================== home
  var STATUS = { "new": ["Received", "new"], contacted: ["Contacted", "progress"], in_progress: ["In progress", "progress"], done: ["Done", "done"], closed: ["Closed", ""] };

  function paintHome() {
    var ov = D.overview || { loans: [], count: 0 };
    var has = ov.count > 0;
    $("loans-card").querySelector(".big-row").hidden = !has;
    $("loans-card").querySelector(".bar").hidden = !has || ov.emi_to_salary_pct == null;
    $("h-free").hidden = !has;
    $("h-empty").hidden = has;
    $("add-loan").hidden = !has;
    if (has) {
      $("h-left").textContent = inr(ov.total_outstanding);
      $("h-emi").textContent = inr(ov.total_emi);
      var p = ov.emi_to_salary_pct;
      $("h-bar").style.width = Math.min(100, p || 0) + "%";
      $("h-free").textContent = "Debt-free in " + monthsText(ov.months_to_debt_free) + (p != null ? " · EMIs take " + p + "% of your salary" : "");
    }
    var ul = $("h-loans"); ul.textContent = ""; ul.hidden = !has;
    ov.loans.forEach(function (l) {
      var li = el("li");
      var left = el("span", "ml-name", typeName(l.type));
      left.appendChild(el("span", "ml-meta", (l.lender || "Lender not given") + " · " + pct(l.rate)));
      li.appendChild(left);
      li.appendChild(el("span", "ml-amt", inr(l.outstanding)));
      ul.appendChild(li);
    });

    var b = bestSaving();
    $("saving-block").hidden = !b;
    if (b) {
      $("h-saving").textContent = inr(b.o.best.net_saving);
      $("h-saving-sub").textContent = "by moving your " + typeName(b.t.loan.type).toLowerCase() + " (" + pct(b.t.loan.rate) + ") to " + b.o.bank + ", after all fees";
    }
    paintScore();
    renderActivity($("h-activity"), activityItems().slice(0, 3));
    $("to-admin").hidden = !D.is_admin;
  }

  function openHome() { show("screen-home"); openTab("home"); }

  // admins land in admin mode unless they've switched to customer view
  function customerView(on) {
    try {
      if (on === undefined) return sessionStorage.getItem("sv-customer-view") === "1";
      if (on) sessionStorage.setItem("sv-customer-view", "1"); else sessionStorage.removeItem("sv-customer-view");
    } catch (e) {}
    return !!on;
  }
  function landing() {
    if (D && D.is_admin && !customerView() && window.SamvaadAdmin) { window.SamvaadAdmin.start(); return; }
    history_ = ["screen-home"]; openHome();
  }
  function backHome() { history_ = ["screen-home"]; openHome(); }
  function refreshHome() { return loadHome().catch(function (e) { toast(e.message); }); }

  var ACT_ICONS = {
    balance_transfer: '<path d="M5 9h12l-3-3M19 15H7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    fresh_loan: '<rect x="4" y="7" width="16" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v5M9.5 12.5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    payoff_help: '<path d="M4 18l6-6 4 3 6-8M15 7h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    callback: '<path d="M7 4h3l1.5 4.5-2.2 1.5a11 11 0 005 5l1.5-2.2L20 14.5v3a2 2 0 01-2 2A15.5 15.5 0 015 6a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  };
  function renderActivity(box, items) {
    box.textContent = "";
    if (!items.length) { box.appendChild(el("p", "empty", "Nothing yet. Pick a service and our executive takes it from there.")); return; }
    items.forEach(function (a) {
      var row = el("button", "act"); row.type = "button";
      var dot = el("span", "act-dot");
      dot.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' + (ACT_ICONS[a.kind] || ACT_ICONS.callback) + "</svg>";
      row.appendChild(dot);
      var body = el("div", "act-body");
      body.appendChild(el("p", "act-title", a.title));
      body.appendChild(el("p", "act-meta", a.meta));
      row.appendChild(body);
      var st = STATUS[a.status] || [a.status, ""];
      row.appendChild(el("span", "pill " + st[1], st[0]));
      row.addEventListener("click", function () { openDone(a.text, a.kind, a.when, true, a.status); });
      box.appendChild(row);
    });
  }

  // ---- bottom tabs
  var TABS = ["home", "services", "activity", "account"];
  function openTab(name, jump) {
    TABS.forEach(function (t) { $("tab-" + t).hidden = t !== name; });
    document.querySelectorAll(".tabbtn").forEach(function (x) { x.classList.toggle("is-on", x.dataset.tab === name); });
    if (name === "activity") renderActivity($("act-all"), activityItems());
    if (name === "account") renderAccount();
    var target = jump && $(jump);
    window.scrollTo(0, target ? target.getBoundingClientRect().top + window.scrollY - 16 : 0);
  }
  document.querySelectorAll("[data-tab]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.dataset.tab === "activity" || b.dataset.tab === "home") refreshHome().then(function () { openTab(b.dataset.tab, b.dataset.jump); });
      openTab(b.dataset.tab, b.dataset.jump);
    });
  });

  function needLoans(what) {
    if (D && D.overview && D.overview.count) return false;
    toast("Add your loans first, then we can " + what + ".");
    openScore();
    return true;
  }

  // ======================================================= Lower my rate
  var bt = { loan: null, offer: null };
  var LOAN_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="6.5" width="17" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  var CHEVRON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function initials(name) { return (name || "?").replace(/\b(Bank|of|India|Finance|Financial|Services|Capital|Ltd|Limited)\b/gi, "").trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase() || name[0]; }

  function btLoans() {
    return (D.transfers || []).map(function (t) {
      var l = t.loan;
      return {
        id: l.id, name: typeName(l.type), lender: l.lender || "Lender not given", rate: l.rate, left: l.outstanding, emi: l.emi,
        best_saving: t.options.length ? t.options[0].best.net_saving : 0,
        offers: t.options.map(function (o, i) {
          return { bank: o.bank, bank_id: o.bank_id, short: initials(o.bank), rate: o.best.rate, emi: o.best.new_emi,
                   save: o.best.net_saving, least: Math.max(0, o.cautious.net_saving), fee: o.processing_fee,
                   foreclosure: o.foreclosure_charge, tag: i === 0 ? "Best saving" : "" };
        })
      };
    });
  }

  function openBtLoans() {
    if (needLoans("find you a lower rate")) return;
    var ul = $("bt-loans"); ul.textContent = "";
    btLoans().forEach(function (l) {
      var li = el("li");
      var b = el("button", "pick"); b.type = "button";
      var ic = el("span", "pick-icon"); ic.innerHTML = LOAN_ICON; b.appendChild(ic);
      var body = el("span", "pick-body");
      body.appendChild(el("span", "pick-name", l.name));
      body.appendChild(el("span", "pick-meta", l.lender + " · " + pct(l.rate) + " · " + inr(l.left) + " left"));
      body.appendChild(l.best_saving > 0 ? el("span", "pick-save", "Save up to " + inr(l.best_saving)) : el("span", "pick-meta", "Already at a good rate"));
      b.appendChild(body);
      var go = el("span", "pick-go"); go.innerHTML = CHEVRON; b.appendChild(go);
      b.addEventListener("click", function () { openBtOffers(l); });
      li.appendChild(b); ul.appendChild(li);
    });
    show("screen-bt-loan"); window.scrollTo(0, 0);
  }

  function openBtOffers(loan) {
    bt.loan = loan; bt.offer = loan.offers[0] || null;
    var now = $("bt-now"); now.textContent = "";
    var a = el("div"); a.appendChild(el("b", null, loan.name + " · " + loan.lender)); a.appendChild(el("span", null, "Now " + pct(loan.rate) + " · EMI " + inr(loan.emi)));
    var c = el("div", "right"); c.appendChild(el("b", null, inr(loan.left))); c.appendChild(el("span", null, "left to pay"));
    now.appendChild(a); now.appendChild(c);

    var ul = $("bt-offers"); ul.textContent = "";
    if (!loan.offers.length) ul.appendChild(el("li", "empty", "No bank on our list beats your current rate once fees are counted, so moving this loan wouldn't save you money. Tap Call us if you'd like our executive to check."));
    loan.offers.forEach(function (o) {
      var li = el("li");
      var b = el("button", "offer"); b.type = "button"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(o === bt.offer));
      b.appendChild(el("span", "offer-logo", o.short));
      var body = el("span", "offer-body");
      body.appendChild(el("span", "offer-name", o.bank));
      body.appendChild(el("span", "offer-meta", "From " + pct(o.rate) + " · EMI " + inr(o.emi)));
      if (o.tag) body.appendChild(el("span", "offer-tag", o.tag));
      b.appendChild(body);
      var s = el("span", "offer-save"); s.appendChild(el("b", null, inr(o.save))); s.appendChild(el("span", null, "you save")); b.appendChild(s);
      b.addEventListener("click", function () {
        bt.offer = o;
        ul.querySelectorAll(".offer").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); });
        $("bt-choose").textContent = "Choose " + o.bank;
      });
      li.appendChild(b); ul.appendChild(li);
    });
    $("bt-choose").parentNode.hidden = !bt.offer;
    if (bt.offer) $("bt-choose").textContent = "Choose " + bt.offer.bank;
    show("screen-bt-offers"); window.scrollTo(0, 0);
  }

  function sumRow(label, value, big) {
    var r = el("div", "sum-row" + (big ? " sum-big" : ""));
    r.appendChild(el("span", null, label)); r.appendChild(el("b", null, value));
    return r;
  }

  // ====================================== shared Confirm + tracker
  var current = null;   // { kind, rows, doneText, payload }
  var STEPS = {
    balance_transfer: [["Our executive calls you", "Within one working day"], ["Documents collected", "We tell you exactly what's needed"],
                       ["Bank approval", "Usually 3 to 7 working days"], ["Loan moved", "Your new EMI starts"]],
    fresh_loan: [["Our executive calls you", "Within one working day"], ["Documents collected", "Salary slips, bank statement, KYC"],
                 ["Bank approval", "Usually 2 to 5 working days"], ["Money in your account", "Straight from the bank"]],
    payoff_help: [["Our executive calls you", "Within one working day"], ["Your plan, step by step", "Which loan to prepay, and when"],
                  ["Monthly check-ins", "We remind you and track progress"]],
    callback: [["Our executive calls you", "At the time you picked"]]
  };
  var NEXT = {
    balance_transfer: ["A Samvaad executive will be in touch within one working day", "They collect your documents and apply with the bank for you", "No charge to you for our help"],
    fresh_loan: ["A Samvaad executive will be in touch within one working day", "They compare banks and apply for you", "No charge to you for our help"],
    payoff_help: ["A Samvaad executive will be in touch within one working day", "They help you follow the plan, month by month", "No charge to you for our help"],
    callback: ["A Samvaad executive will call you at the time you picked", "No charge to you for our help"]
  };
  // how far along the tracker is, from the status you set in admin
  var PROGRESS = { "new": 1, contacted: 2, in_progress: 3, done: 99, closed: 99 };

  function openConfirm(cfg) {
    current = cfg;
    var s = $("bt-summary"); s.textContent = "";
    cfg.rows.forEach(function (r) { s.appendChild(sumRow(r[0], r[1], r[2])); });
    var next = $("c-next"); next.textContent = "";
    (NEXT[cfg.kind] || NEXT.callback).forEach(function (t) { next.appendChild(el("li", null, t)); });
    $("c-err").textContent = "";
    $("c-phone").value = ((D && D.profile && D.profile.phone) || "").replace(/\D/g, "").slice(-10);
    $("c-note").value = "";
    show("screen-bt-confirm"); window.scrollTo(0, 0);
  }

  function openBtConfirm() {
    var l = bt.loan, o = bt.offer;
    var rows = [["Move", l.name + " · " + inr(l.left)], ["From", l.lender + " at " + pct(l.rate)],
                ["To", o.bank + " from " + pct(o.rate)], ["New EMI", "about " + inr(o.emi)],
                ["Processing fee", inr(o.fee) + " (counted)"]];
    if (o.foreclosure) rows.push(["Foreclosure charge", inr(o.foreclosure) + " (counted)"]);
    rows.push(["You save", (o.least > 0 && o.least < o.save ? inr(o.least) + " – " : "up to ") + inr(o.save), true]);
    openConfirm({ kind: "balance_transfer", doneText: "Lower my rate · " + l.name + " to " + o.bank, rows: rows,
                  payload: { loan_id: l.id, bank_id: o.bank_id } });
  }
  $("bt-choose").addEventListener("click", openBtConfirm);

  $("c-phone").addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 10); });
  $("confirm-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var ph = $("c-phone").value.replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(ph)) { $("c-err").textContent = "Enter your 10-digit mobile number."; return; }
    $("c-err").textContent = "";
    var btn = $("c-btn"); busy(btn, true);
    var body = Object.assign({ kind: current.kind, phone: "+91" + ph, note: $("c-note").value.trim() }, current.payload || {});
    api("POST", "/api/requests", body).then(function () {
      return loadHome();
    }).then(function () {
      openDone(current.doneText, current.kind);
    }).catch(function (err) { $("c-err").textContent = err.message; }).finally(function () { busy(btn, false); });
  });

  function openDone(text, kind, whenText, viewing, status) {
    $("done-sub").textContent = text;
    $("screen-bt-done").querySelector(".done-head .ask").textContent = viewing ? "Your request" : "Request received";
    $("screen-bt-done").querySelector(".tick").hidden = viewing && status !== "done";
    $("exec-when").textContent = kind === "callback" ? "at the time you picked" : "within one working day";
    $("screen-bt-done").querySelector(".exec-card").hidden = status === "done" || status === "closed";
    var steps = [["Request received", whenText || "Just now"]].concat(STEPS[kind] || STEPS.callback);
    var at = PROGRESS[status || "new"] || 1;
    var ol = $("done-track"); ol.textContent = "";
    steps.forEach(function (st, i) {
      var li = el("li", i < at ? "on" : i === at ? "now" : "");
      li.appendChild(el("b", null, st[0])); li.appendChild(el("span", null, st[1])); ol.appendChild(li);
    });
    if (status === "closed") { var c = el("li", "on"); c.appendChild(el("b", null, "Closed")); c.appendChild(el("span", null, "Call us if you'd like to start again")); ol.appendChild(c); }
    history_ = viewing ? ["screen-home", "screen-bt-done"] : ["screen-home"];
    show("screen-bt-done"); window.scrollTo(0, 0);
  }
  $("done-home").addEventListener("click", backHome);
  $("done-close").addEventListener("click", backHome);

  // ============================================================ New loan
  var NL_TYPES = [
    ["personal", "Personal", '<path d="M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20.5a7.5 7.5 0 0115 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'],
    ["home", "Home", '<path d="M4 11l8-7 8 7v9H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 20v-5h4v5" fill="none" stroke="currentColor" stroke-width="2"/>'],
    ["car", "Car", '<path d="M5 16V12l2-5h10l2 5v4M3.5 16h17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="7.5" cy="17" r="1.8" fill="currentColor"/><circle cx="16.5" cy="17" r="1.8" fill="currentColor"/>'],
    ["two_wheeler", "Two-wheeler", '<circle cx="6" cy="16" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 16l4-6h5l3 6M13 6h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
    ["education", "Education", '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6.5 11.5V16c3 2.2 8 2.2 11 0v-4.5" fill="none" stroke="currentColor" stroke-width="2"/>'],
    ["business", "Business", '<rect x="3.5" y="7.5" width="17" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 7.5V5h6v2.5" fill="none" stroke="currentColor" stroke-width="2"/>'],
    ["gold", "Gold", '<path d="M4 18l2.5-6h11L20 18zM8.5 12l1.5-5h4l1.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>']
  ];
  var NL_CHIPS = { personal: [100000, 300000, 500000], home: [2000000, 3000000, 5000000], car: [500000, 800000, 1000000],
                   two_wheeler: [80000, 120000, 150000], education: [500000, 1000000, 1500000], business: [300000, 500000, 1000000], gold: [100000, 200000, 300000] };
  var nl = { type: null, label: "", max: null };

  function openNlTypes() {
    var g = $("nl-types"); g.textContent = "";
    NL_TYPES.forEach(function (t) {
      var b = el("button", "type"); b.type = "button";
      var ic = el("span"); ic.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' + t[2] + "</svg>";
      b.appendChild(ic); b.appendChild(el("span", null, t[1]));
      b.addEventListener("click", function () { openNlAmount(t[0], t[1]); });
      g.appendChild(b);
    });
    show("screen-nl-type"); window.scrollTo(0, 0);
  }

  function lakh(n) { return n >= 10000000 ? "₹" + (n / 10000000) + " Cr" : "₹" + (n / 100000) + "L"; }
  function amountValue() { return Number($("nl-amount").value.replace(/\D/g, "")) || 0; }
  function setAmount(n) { $("nl-amount").value = n ? fmt.format(n) : ""; syncChips(); }
  function syncChips() {
    var v = amountValue();
    $("nl-chips").querySelectorAll(".chip").forEach(function (c) { c.setAttribute("aria-pressed", String(Number(c.dataset.v) === v)); });
  }

  function paintElig() {
    var salary = D.profile && D.profile.salary;
    var e = (D.eligibility || {})[nl.type];
    var maxBox = $("nl-max").parentNode;
    $("nl-salary").hidden = !!salary;
    nl.max = null;
    if (!salary) {
      maxBox.hidden = true;
      $("nl-room").textContent = "Add your monthly take-home salary and we'll show how much banks would usually lend you.";
      return;
    }
    maxBox.hidden = false;
    if (!e) {
      maxBox.hidden = true;
      $("nl-room").textContent = "We don't have bank rates for this loan type in the app yet. Our executive will check offers for you.";
      return;
    }
    if (!e.emi_room) {
      $("nl-max").textContent = "₹0";
      $("nl-room").textContent = "Your EMIs already take about half your salary, which is the most banks usually allow. Closing a loan first would help. Our executive can advise.";
      nl.max = 0;
      return;
    }
    var best = e.offers && e.offers[0];
    nl.max = best ? best.max_amount : null;
    $("nl-max").textContent = best ? inr(best.max_amount) : "—";
    $("nl-room").textContent = "Your EMIs can go up by about " + inr(e.emi_room) + " a month. Banks keep all EMIs within about " + e.foir_pct + "% of your take-home pay." +
      (best ? " Best offer: " + best.bank + " from " + pct(best.rate_min) + "." : "");
  }

  function openNlAmount(type, label) {
    nl.type = type; nl.label = label + " loan";
    $("nl-title").textContent = nl.label;
    var c = $("nl-chips"); c.textContent = "";
    NL_CHIPS[type].forEach(function (v) {
      var b = el("button", "chip", lakh(v)); b.type = "button"; b.dataset.v = v;
      b.addEventListener("click", function () { setAmount(v); });
      c.appendChild(b);
    });
    setAmount(0); $("nl-err").textContent = "";
    paintElig();
    show("screen-nl-amount"); window.scrollTo(0, 0);
  }
  $("nl-amount").addEventListener("input", function () { var v = amountValue(); this.value = v ? fmt.format(v) : ""; syncChips(); });
  $("nl-sal-in").addEventListener("input", function () { var v = Number(this.value.replace(/\D/g, "")); this.value = v ? fmt.format(v) : ""; });
  $("nl-sal-save").addEventListener("click", function () {
    var v = Number($("nl-sal-in").value.replace(/\D/g, ""));
    if (!(v >= 5000)) { $("nl-err").textContent = "Enter your monthly take-home salary, e.g. 85,000."; return; }
    var btn = this; busy(btn, true); $("nl-err").textContent = "";
    api("PUT", "/api/me", { salary: v }).then(loadHome).then(paintElig).catch(function (err) { $("nl-err").textContent = err.message; }).finally(function () { busy(btn, false); });
  });
  $("nl-go").addEventListener("click", function () {
    var v = amountValue();
    if (v < 10000) { $("nl-err").textContent = "Enter how much you need."; return; }
    $("nl-err").textContent = "";
    var rows = [["Loan", nl.label], ["Amount", inr(v)]];
    if (nl.max != null) rows.push(["You can borrow up to", "about " + inr(nl.max)]);
    if (nl.max != null && v > nl.max) rows.push(["Note", "More than your usual limit. We'll check options."]);
    openConfirm({ kind: "fresh_loan", doneText: "New loan · " + nl.label + " of " + inr(v), rows: rows,
                  payload: { loan_type: nl.type, amount: inr(v) } });
  });

  // ======================================================== Close faster
  var pfPick = null;
  function openPayoff() {
    if (needLoans("plan how to close them")) return;
    var c = $("pf-chips"); c.textContent = "";
    ["2000", "5000", "10000"].forEach(function (k) {
      var o = D.plans[k]; if (!o) return;
      var b = el("button", "chip", "+" + inr(o.extra)); b.type = "button"; b.setAttribute("role", "radio");
      b.addEventListener("click", function () { pickPf(o); });
      b._opt = o; c.appendChild(b);
    });
    var any = D.plans["5000"] || D.plans["2000"];
    $("pf-usual").textContent = monthsText(any.usual_months);
    var ol = $("pf-order"); ol.textContent = "";
    any.order.forEach(function (l) {
      var li = el("li"); li.appendChild(el("span", null, typeName(l.type) + (l.lender ? " · " + l.lender : ""))); li.appendChild(el("span", "r", pct(l.rate))); ol.appendChild(li);
    });
    pickPf(D.plans["5000"] || any);
    show("screen-pf"); window.scrollTo(0, 0);
  }
  function pickPf(o) {
    pfPick = o;
    $("pf-chips").querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-checked", String(b._opt === o)); });
    $("pf-new").textContent = monthsText(o.plan_months);
    $("pf-saved").textContent = inr(o.interest_saved);
  }
  $("pf-go").addEventListener("click", function () {
    var o = pfPick, first = o.order[0];
    openConfirm({ kind: "payoff_help", doneText: "Close faster · " + inr(o.extra) + " extra a month",
      rows: [["Extra each month", inr(o.extra)], ["Debt-free in", monthsText(o.plan_months) + " (instead of " + monthsText(o.usual_months) + ")"],
             ["Start with", typeName(first.type) + " (" + pct(first.rate) + ")"], ["Interest you save", inr(o.interest_saved), true]],
      payload: { extra: o.extra } });
  });

  // ============================================================= Call me
  var CB_TIMES = ["As soon as possible", "Morning, 9 am to 12 pm", "Afternoon, 12 to 4 pm", "Evening, 4 to 8 pm"];
  var CB_TOPICS = ["My loans", "Lower my rate", "New loan", "Credit card debt", "Something else"];
  var cb = { time: CB_TIMES[0], topic: "My loans" };
  function openCallback() {
    var ul = $("cb-times"); ul.textContent = "";
    CB_TIMES.forEach(function (t) {
      var li = el("li"); var b = el("button", "pick"); b.type = "button"; b.setAttribute("role", "radio");
      b.appendChild(el("span", "pick-body")).appendChild(el("span", "pick-name", t));
      b.appendChild(el("span", "radio-dot"));
      b.addEventListener("click", function () { cb.time = t; syncCb(); });
      b._v = t; li.appendChild(b); ul.appendChild(li);
    });
    var c = $("cb-topics"); c.textContent = "";
    CB_TOPICS.forEach(function (t) {
      var b = el("button", "chip", t); b.type = "button"; b._v = t;
      b.addEventListener("click", function () { cb.topic = t; syncCb(); });
      c.appendChild(b);
    });
    syncCb();
    show("screen-cb"); window.scrollTo(0, 0);
  }
  function syncCb() {
    $("cb-times").querySelectorAll(".pick").forEach(function (b) { b.setAttribute("aria-checked", String(b._v === cb.time)); });
    $("cb-topics").querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-pressed", String(b._v === cb.topic)); });
  }
  $("cb-go").addEventListener("click", function () {
    openConfirm({ kind: "callback", doneText: "Call me · " + cb.time.toLowerCase(), rows: [["Call me", cb.time], ["About", cb.topic]],
                  payload: { call_time: cb.time, topic: cb.topic } });
  });

  // ========================================================= CIBIL score
  function band(v) {
    if (v >= 750) return ["Excellent", "good", "Banks see you as low risk. You should get their best rates."];
    if (v >= 700) return ["Good", "good", "Most banks will approve you. A few points more gets you their best rates."];
    if (v >= 650) return ["Fair", "ok", "You can get a loan, but rates may be higher. We'll find the banks most likely to say yes."];
    return ["Needs work", "low", "Some banks may say no. Our executive can show you how to raise it before you apply."];
  }
  function paintScore() {
    var p = (D && D.profile) || {}, v = p.cibil_score, ring = $("h-score-ring");
    ring.className = "score-ring";
    if (!v) {
      $("h-score-num").textContent = "?"; $("h-score-sub").textContent = "Check yours free. It doesn't lower your score.";
      $("sc-gauge").hidden = true; $("sc-ask").textContent = "Get your CIBIL score"; return;
    }
    var b = band(v), date = p.cibil_date ? niceDate(p.cibil_date) : "";
    ring.classList.add(b[1]); $("h-score-num").textContent = v;
    $("h-score-sub").textContent = b[0] + (date ? " · updated " + date : "");
    $("sc-gauge").hidden = false;
    $("sc-num").textContent = v; $("sc-band").textContent = b[0];
    $("sc-band").style.color = b[1] === "good" ? "#1d6b34" : b[1] === "ok" ? "#8a5d00" : "#c62828";
    $("sc-arc").setAttribute("stroke", b[1] === "good" ? "#1d6b34" : b[1] === "ok" ? "#c98a00" : "#c62828");
    $("sc-arc").setAttribute("stroke-dasharray", Math.round((v - 300) / 6) + " 100");
    $("sc-meaning").textContent = b[2];
    $("sc-when").textContent = (date ? "Updated " + date + ". " : "") + "You get a new free report every year.";
    $("sc-ask").textContent = "Update your score";
  }
  function resetUpload() {
    $("sc-file").value = ""; $("sc-file-name").textContent = "Upload CIBIL report (PDF)";
    $("sc-file").parentNode.classList.remove("has-file");
  }
  function openScore() {
    paintScore(); $("sc-err").textContent = ""; $("sc-msg").textContent = ""; $("sc-pass").hidden = true; resetUpload();
    show("screen-score"); window.scrollTo(0, 0);
  }
  $("h-score").addEventListener("click", openScore);
  $("h-empty-cibil").addEventListener("click", openScore);
  $("sc-input").addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 3); });
  $("sc-save").addEventListener("click", function () {
    var v = Number($("sc-input").value);
    if (!(v >= 300 && v <= 900)) { $("sc-err").textContent = "A CIBIL score is between 300 and 900."; return; }
    $("sc-err").textContent = "";
    var btn = this; busy(btn, true);
    api("PUT", "/api/cibil", { score: v }).then(function () { $("sc-input").value = ""; return loadHome(); })
      .then(function () { paintScore(); window.scrollTo(0, 0); toast("Score saved."); })
      .catch(function (err) { $("sc-err").textContent = err.message; }).finally(function () { busy(btn, false); });
  });

  var pendingFile = null;
  $("sc-file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { $("sc-err").textContent = "Choose the PDF report from CIBIL."; resetUpload(); return; }
    if (f.size > 4 * 1024 * 1024) { $("sc-err").textContent = "That file is over 4 MB. Download the report again from CIBIL as a PDF."; resetUpload(); return; }
    $("sc-err").textContent = ""; $("sc-msg").textContent = "";
    pendingFile = f;
    $("sc-file-name").textContent = f.name;
    this.parentNode.classList.add("has-file");
    readReport(f, "");
  });
  $("sc-pass-go").addEventListener("click", function () {
    var pw = $("sc-pass-in").value.trim();
    if (!pw) { $("sc-err").textContent = "Enter the report's password."; return; }
    if (pendingFile) readReport(pendingFile, pw);
  });

  function readReport(file, password) {
    var items = $("read-steps").querySelectorAll("li");
    items.forEach(function (li) { li.className = ""; });
    show("screen-read"); window.scrollTo(0, 0);
    var timers = [];
    items.forEach(function (li, i) { if (i < items.length - 1) timers.push(setTimeout(function () { li.className = "done"; }, 500 + i * 900)); });
    var fd = new FormData(); fd.append("report", file, file.name || "cibil.pdf");
    if (password) fd.append("password", password);
    var started = Date.now();
    api("POST", "/api/cibil/report", fd).then(function (d) {
      var wait = Math.max(0, 1600 - (Date.now() - started));
      setTimeout(function () {
        timers.forEach(clearTimeout);
        items.forEach(function (li) { li.className = "done"; });
        loadHome().then(function () {
          var r = d.result;
          history_ = ["screen-home"];
          if (r && r.accounts && r.accounts.length) { openFound(r); return; }
          openScore();
          if (r && r.score) toast("Score " + r.score + " saved. We didn't find any open loans in the report.");
          else $("sc-msg").textContent = d.message || "Report saved. Our executive will go through it.";
        });
      }, wait);
    }).catch(function (err) {
      timers.forEach(clearTimeout);
      history_ = ["screen-home", "screen-score"];
      show("screen-score");
      if (err.data && err.data.needs_password) {
        $("sc-pass").hidden = false; $("sc-pass-in").focus();
        $("sc-err").textContent = err.message;
        return;
      }
      resetUpload(); $("sc-err").textContent = err.message;
    });
  }

  var found = null;
  function openFound(rep) {
    found = rep;
    var b = rep.score ? band(rep.score) : ["", "", ""];
    $("f-ring").className = "score-ring " + b[1]; $("f-score").textContent = rep.score || "—";
    var n = rep.accounts.length;
    $("f-title").textContent = "We found " + n + " open account" + (n === 1 ? "" : "s");
    var ul = $("f-list"); ul.textContent = "";
    rep.accounts.forEach(function (l) {
      l.keep = true;
      var li = el("li", "found");
      var top = el("div", "found-top");
      var ic = el("span", "pick-icon"); ic.innerHTML = LOAN_ICON; top.appendChild(ic);
      var mid = el("div"); mid.appendChild(el("div", "found-name", l.type_label || typeName(l.type)));
      mid.appendChild(el("div", "found-meta", (l.lender || "Lender") + (l.opened ? " · since " + l.opened : ""))); top.appendChild(mid);
      var amt = el("div", "found-amt"); amt.appendChild(el("b", null, inr(l.outstanding))); amt.appendChild(el("span", null, "left to pay")); top.appendChild(amt);
      li.appendChild(top);
      var f = el("div", "found-fields");
      var card = l.type === "credit_card";
      f.appendChild(miniField("Rate %", l.rate, card ? "e.g. 36" : "e.g. 14", function (v) { l.rate = v; }, true));
      f.appendChild(miniField(card ? "Pay / month" : "EMI", l.emi, card ? "Optional" : "e.g. 10500", function (v) { l.emi = v; }, !card));
      li.appendChild(f);
      var t = el("label", "found-toggle");
      var cbx = el("input"); cbx.type = "checkbox"; cbx.checked = true;
      cbx.addEventListener("change", function () { l.keep = cbx.checked; li.classList.toggle("off", !cbx.checked); countFound(); });
      t.appendChild(cbx); t.appendChild(document.createTextNode("Add this to my loans"));
      li.appendChild(t);
      l._li = li;
      ul.appendChild(li);
    });
    $("f-err") && ($("f-err").textContent = "");
    countFound();
    history_ = ["screen-home", "screen-score"];
    show("screen-found"); window.scrollTo(0, 0);
  }
  function miniField(label, value, ph, onSet, needed) {
    var w = el("label", "mini-field" + (needed && !value ? " need" : ""));
    var lab = el("span", null, label);
    if (value) lab.appendChild(el("span", "from-report", " ✓ from CIBIL"));
    w.appendChild(lab);
    var inp = el("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.placeholder = ph;
    if (value) inp.value = fmt.format(value);
    inp.addEventListener("input", function () {
      var v = parseFloat(inp.value.replace(/[^0-9.]/g, "")) || null;
      onSet(v); w.classList.toggle("need", !!needed && !v);
    });
    w.appendChild(inp);
    return w;
  }
  function countFound() {
    var k = found.accounts.filter(function (l) { return l.keep; }).length;
    $("f-save").textContent = k ? "Add " + k + " loan" + (k === 1 ? "" : "s") : "Skip for now";
  }
  $("f-save").addEventListener("click", function () {
    var keep = found.accounts.filter(function (l) { return l.keep; });
    if (!keep.length) { backHome(); return; }
    var missing = keep.filter(function (l) { return !l.rate || (l.type !== "credit_card" && !l.emi); });
    if (missing.length) {
      toast("Add the " + (missing[0].rate ? "EMI" : "interest rate") + " for your " + (missing[0].type_label || "loan").toLowerCase() + " with " + (missing[0].lender || "the lender") + ".");
      missing[0]._li.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    var btn = this; busy(btn, true);
    api("POST", "/api/loans/bulk", { loans: keep.map(function (l) { return { type: l.type, lender: l.lender, outstanding: l.outstanding, rate: l.rate, emi: l.emi || "" }; }) })
      .then(loadHome).then(function () { backHome(); toast(keep.length + " loan" + (keep.length === 1 ? "" : "s") + " added from your CIBIL report."); })
      .catch(function (err) { toast(err.message); if (err.data && err.data.index != null && keep[err.data.index]) keep[err.data.index]._li.scrollIntoView({ block: "center" }); })
      .finally(function () { busy(btn, false); });
  });

  // ======================================================== Add a loan
  var ADD_TYPES = NL_TYPES.concat([
    ["credit_card", "Credit card", '<rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M7 14.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'],
    ["other", "Other", '<circle cx="6.5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="17.5" cy="12" r="1.6" fill="currentColor"/>']
  ]);
  var LENDERS = ["HDFC Bank", "SBI", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Bajaj Finance", "IDFC FIRST Bank",
    "Tata Capital", "Bank of Baroda", "Punjab National Bank", "Canara Bank", "Union Bank of India", "IndusInd Bank",
    "Yes Bank", "Federal Bank", "Aditya Birla Capital", "HDB Financial Services", "Mahindra Finance",
    "LIC Housing Finance", "Muthoot Finance", "Hero FinCorp", "Poonawalla Fincorp"];
  var POPULAR = 8;
  var add = { type: null, label: "", lender: "" };

  function openAddType() {
    var g = $("add-types"); g.textContent = "";
    ADD_TYPES.forEach(function (t) {
      var b = el("button", "type"); b.type = "button";
      var ic = el("span"); ic.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' + t[2] + "</svg>";
      b.appendChild(ic); b.appendChild(el("span", null, t[1]));
      b.addEventListener("click", function () {
        add.type = t[0]; add.label = t[0] === "credit_card" ? "Credit card" : t[0] === "other" ? "Other loan" : t[1] + " loan";
        openAddLender();
      });
      g.appendChild(b);
    });
    show("screen-add-type"); window.scrollTo(0, 0);
  }
  function lenderRow(name, other) {
    var li = el("li");
    var b = el("button", "lender" + (other ? " lender-other" : "")); b.type = "button";
    b.appendChild(el("span", "lender-mark", other ? "+" : initials(name)));
    b.appendChild(el("span", null, other ? 'Use "' + name + '"' : name));
    b.addEventListener("click", function () { add.lender = name; openAddDetails(); });
    li.appendChild(b); return li;
  }
  function renderLenders() {
    var q = $("add-lender-q").value.trim(), ql = q.toLowerCase(), ul = $("add-lenders"); ul.textContent = "";
    var list = q ? LENDERS.filter(function (n) { return n.toLowerCase().indexOf(ql) !== -1; }) : LENDERS;
    if (!q) ul.appendChild(el("li", "list-label", "Popular"));
    list.forEach(function (n, i) {
      if (!q && i === POPULAR) ul.appendChild(el("li", "list-label", "More lenders"));
      ul.appendChild(lenderRow(n));
    });
    if (q && !list.some(function (n) { return n.toLowerCase() === ql; })) ul.appendChild(lenderRow(q.slice(0, 40), true));
  }
  function openAddLender() {
    $("add-lender-title").textContent = add.label;
    $("add-lender-q").value = ""; renderLenders();
    show("screen-add-lender"); window.scrollTo(0, 0);
  }
  $("add-lender-q").addEventListener("input", renderLenders);

  function num(id) { return parseFloat($(id).value.replace(/[^0-9.]/g, "")) || 0; }
  function openAddDetails() {
    $("add-details-title").textContent = add.label + " · " + add.lender;
    ["add-amount", "add-rate", "add-emi"].forEach(function (id) { $(id).value = ""; });
    $("add-emi").placeholder = add.type === "credit_card" ? "Optional" : "10,500";
    $("add-preview").hidden = true; $("add-err").textContent = "";
    show("screen-add-details"); window.scrollTo(0, 0);
  }
  function money(id) { var v = num(id); $(id).value = v ? fmt.format(v) : ""; }
  $("add-amount").addEventListener("input", function () { money("add-amount"); preview(); });
  $("add-emi").addEventListener("input", function () { money("add-emi"); preview(); });
  $("add-rate").addEventListener("input", function () { this.value = this.value.replace(/[^0-9.]/g, "").slice(0, 5); preview(); });

  // Quick on-screen estimate while typing; the server's loan engine does the real maths.
  function preview() {
    var P = num("add-amount"), R = num("add-rate"), E = num("add-emi") || (add.type === "credit_card" ? Math.max(200, P * 0.05) : 0), pv = $("add-preview");
    if (!(P > 0 && R > 0 && E > 0)) { pv.hidden = true; return; }
    pv.hidden = false;
    var r = R / 1200, note = "";
    if (E <= P * r) {
      $("pv-close").textContent = "Never at this EMI"; $("pv-int").textContent = "—";
      note = "This EMI doesn't cover the monthly interest. Check the EMI or the rate.";
    } else {
      var n = Math.ceil(-Math.log(1 - r * P / E) / Math.log(1 + r));
      $("pv-close").textContent = monthsText(n);
      $("pv-int").textContent = inr(Math.max(0, E * n - P));
      if ((add.type === "credit_card" && R >= 24) || (add.type !== "home" && add.type !== "credit_card" && R >= 13) || (add.type === "home" && R >= 9.5))
        note = "This rate is on the high side. After saving, check Lower my rate.";
    }
    $("pv-note").textContent = note;
  }

  $("add-save").addEventListener("click", function () {
    var P = num("add-amount"), R = num("add-rate"), E = num("add-emi");
    if (!(P >= 1000)) { $("add-err").textContent = "Enter the amount left to pay."; return; }
    if (!(R > 0 && R <= 60)) { $("add-err").textContent = "Enter the yearly interest rate, e.g. 14."; return; }
    if (!(E > 0) && add.type !== "credit_card") { $("add-err").textContent = "Enter the monthly EMI."; return; }
    $("add-err").textContent = "";
    var btn = this; busy(btn, true);
    api("POST", "/api/loans", { type: add.type, lender: add.lender, outstanding: P, rate: R, emi: E || "" })
      .then(loadHome).then(function () {
        backHome();
        var card = $("loans-card"); window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 70);
        var last = $("h-loans").lastChild; if (last) { last.classList.add("just-added"); setTimeout(function () { last.classList.remove("just-added"); }, 1600); }
      })
      .catch(function (err) { $("add-err").textContent = err.message; }).finally(function () { busy(btn, false); });
  });
  $("add-loan").addEventListener("click", openAddType);
  $("add-cibil").addEventListener("click", openScore);

  // ============================================================ Ask Ritu
  var chat = [], chatStarted = false, sending = false;
  var SUGGEST = ["How do I close my loans faster?", "Should I move my loan to another bank?", "How much more can I borrow?", "Mera EMI kaise kam hoga?"];
  var ACTION_ICONS = {
    balance_transfer: '<path d="M5 9h12l-3-3M19 15H7l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    payoff_help: '<path d="M4 18l6-6 4 3 6-8M15 7h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    fresh_loan: '<rect x="4" y="7" width="16" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v5M9.5 12.5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  function actionFor(q, reply) {
    var t = (q + " " + reply).toLowerCase();
    var b = bestSaving();
    if (/move|transfer|switch|cheaper|lower|shift|balance/.test(q.toLowerCase()) && b) return ["balance_transfer", "Lower my rate", "Save up to " + inr(b.o.best.net_saving)];
    if (/fast|close|prepay|early|debt.?free|jaldi|extra/.test(q.toLowerCase()) && D.plans && D.plans["5000"]) return ["payoff_help", "Close faster", "Save " + inr(D.plans["5000"].interest_saved) + " in interest"];
    if (/borrow|new loan|eligib|more loan|kitna|naya/.test(q.toLowerCase())) return ["fresh_loan", "New loan", "See how much you can borrow"];
    if (/get this done|balance transfer|move it/.test(t) && b) return ["balance_transfer", "Lower my rate", "Save up to " + inr(b.o.best.net_saving)];
    return null;
  }
  function bubble(text, who) { var m = el("div", "msg " + who, text); if (/[ऀ-ॿ]/.test(text)) m.lang = "hi"; $("chat-log").appendChild(m); scrollChat(); return m; }
  function scrollChat() { var l = $("chat-log"); l.scrollTop = l.scrollHeight; }
  function actionCard(a) {
    if (!a) return;
    var b = el("button", "msg-action"); b.type = "button";
    var ic = el("span", "tile-icon"); ic.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + ACTION_ICONS[a[0]] + "</svg>"; b.appendChild(ic);
    var body = el("span"); body.appendChild(el("b", null, a[1])); body.appendChild(el("span", "a-sub", a[2])); b.appendChild(body);
    b.addEventListener("click", function () { SERVICES[a[0]](); });
    $("chat-log").appendChild(b); scrollChat();
  }
  function renderSuggest() {
    var sg = $("chat-suggest"); sg.textContent = "";
    SUGGEST.forEach(function (q) {
      var c = el("button", "chip", q); c.type = "button";
      c.addEventListener("click", function () { send(q); });
      sg.appendChild(c);
    });
  }
  function send(text) {
    text = (text || "").trim(); if (!text || sending) return;
    sending = true;
    bubble(text, "me");
    $("chat-input").value = ""; $("chat-send").disabled = true;
    $("chat-suggest").hidden = true;
    var t = el("div", "typing"); t.innerHTML = "<i></i><i></i><i></i>"; $("chat-log").appendChild(t); scrollChat();
    api("POST", "/api/ritu", { message: text, history: chat.slice(-12) }).then(function (d) {
      t.remove(); bubble(d.reply, "ritu");
      chat.push({ role: "user", content: text }, { role: "assistant", content: d.reply });
      actionCard(actionFor(text, d.reply));
    }).catch(function (err) { t.remove(); bubble(err.message, "ritu err-msg"); })
      .finally(function () { sending = false; });
  }
  function greeting() {
    var ov = D.overview || {};
    if (!ov.count) return "Hi, I'm Ritu, your loan advisor.\n\nAdd your loans, or upload your CIBIL report, and I'll show you how to pay less and close them sooner. You can ask me anything, in English or Hindi.";
    var worst = ov.loans.slice().sort(function (a, b) { return b.rate - a.rate; })[0];
    return "Hi, I'm Ritu. I've looked at your " + ov.count + " loan" + (ov.count === 1 ? "" : "s") + ".\n\nYour " + typeName(worst.type).toLowerCase() +
      " at " + pct(worst.rate) + " is costing you the most. Ask me anything, in English or Hindi.";
  }
  function openRitu() {
    if (!chatStarted) {
      chatStarted = true;
      $("chat-log").appendChild(el("div", "msg-day", "Today"));
      bubble(greeting(), "ritu");
      renderSuggest();
    }
    show("screen-ritu");
    setTimeout(scrollChat, 0);
  }
  $("chat-input").addEventListener("input", function () { $("chat-send").disabled = !this.value.trim(); });
  $("chat-form").addEventListener("submit", function (e) { e.preventDefault(); send($("chat-input").value); });
  $("ask-bar").addEventListener("click", openRitu);

  // voice: tap to record, tap again to send (Sarvam turns it into text)
  var rec = null;
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
    for (var k = 0, off = 44; k < len; k++, off += 2) { var x = Math.max(-1, Math.min(1, pcm[k])); v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([buf], { type: "audio/wav" });
  }
  $("chat-mic").addEventListener("click", function () {
    var mic = this;
    if (!D || !D.voice) { toast("Voice isn't switched on yet. Type your question instead."); return; }
    if (rec) {
      var r = rec; rec = null;
      mic.classList.remove("on"); mic.setAttribute("aria-label", "Speak");
      r.proc.disconnect(); r.src.disconnect(); r.stream.getTracks().forEach(function (t) { t.stop(); });
      var blob = encodeWav(r.chunks, r.ctx.sampleRate); r.ctx.close();
      var fd = new FormData(); fd.append("audio", blob, "question.wav");
      $("chat-input").placeholder = "Listening to what you said…";
      api("POST", "/api/ritu/listen", fd).then(function (d) { if (d.text) send(d.text); else toast("Didn't catch that. Try again or type it."); })
        .catch(function (err) { toast(err.message); }).finally(function () { $("chat-input").placeholder = "Ask about your loans…"; });
      return;
    }
    if (!navigator.mediaDevices) { toast("Voice needs the secure (https) app. Type your question instead."); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC(), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), chunks = [];
      proc.onaudioprocess = function (e) { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(proc); proc.connect(ctx.destination);
      rec = { ctx: ctx, src: src, proc: proc, stream: stream, chunks: chunks };
      mic.classList.add("on"); mic.setAttribute("aria-label", "Stop and send");
      $("chat-input").placeholder = "Recording… tap the mic again to send";
    }).catch(function () { toast("Microphone blocked. Allow it, or type instead."); });
  });

  // ============================================================ Account
  function renderAccount() {
    var p = D.profile || {}, u = D.user || {};
    var name = p.name || u.name || "";
    $("me-name").textContent = name || "Your account";
    $("me-avatar").textContent = (name || p.email || u.email || "S").trim()[0].toUpperCase();
    var idBox = $("me-id"); idBox.textContent = "";
    var phone = (p.phone || "").replace(/\D/g, "").slice(-10);
    var parts = [p.email || u.email, phone ? "+91 " + phone.slice(0, 5) + " " + phone.slice(5) : ""].filter(Boolean);
    if (!parts.length) idBox.textContent = "Add your details below";
    parts.forEach(function (t, i) { if (i) idBox.appendChild(document.createTextNode(" · ")); idBox.appendChild(el("span", "nowrap", t)); });
    $("me-f-name").value = name; $("me-f-phone").value = phone;
    $("me-f-salary").value = p.salary ? fmt.format(p.salary) : "";
    $("me-f-employer").value = p.employer || ""; $("me-f-city").value = p.city || "";
    $("me-err").textContent = ""; $("me-err").className = "err";
    $("acc-admin").hidden = !D.is_admin;
    $("acc-cibil-sub").textContent = p.cibil_score ? p.cibil_score + " · " + band(p.cibil_score)[0] : "Not added yet";

    var ul = $("acc-loan-list"); ul.textContent = "";
    var loans = (D.overview && D.overview.loans) || [];
    if (!loans.length) ul.appendChild(el("li", "empty", "No loans yet. Add one, or upload your CIBIL report."));
    loans.forEach(function (l) {
      var li = el("li");
      var left = el("span", "ml-name", typeName(l.type)); left.appendChild(el("span", "ml-meta", (l.lender || "Lender not given") + " · " + pct(l.rate) + " · EMI " + inr(l.emi)));
      li.appendChild(left);
      var right = el("span", "ml-right"); right.appendChild(el("span", "ml-amt", inr(l.outstanding)));
      var del = el("button", "del"); del.type = "button"; del.setAttribute("aria-label", "Remove " + typeName(l.type));
      del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
      del.addEventListener("click", function () {
        if (!confirm("Remove your " + typeName(l.type).toLowerCase() + (l.lender ? " with " + l.lender : "") + "?")) return;
        api("DELETE", "/api/loans/" + encodeURIComponent(l.id)).then(loadHome).then(renderAccount).catch(function (err) { toast(err.message); });
      });
      right.appendChild(del); li.appendChild(right); ul.appendChild(li);
    });
  }
  $("me-f-salary").addEventListener("input", function () { var v = Number(this.value.replace(/\D/g, "")); this.value = v ? fmt.format(v) : ""; });
  $("me-f-phone").addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 10); });
  $("me-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var ph = $("me-f-phone").value;
    if (ph && !/^[6-9]\d{9}$/.test(ph)) { $("me-err").textContent = "Enter a valid 10-digit mobile number."; return; }
    var btn = $("me-save"); busy(btn, true);
    api("PUT", "/api/me", {
      name: $("me-f-name").value.trim().slice(0, 60), phone: ph ? "+91" + ph : "",
      salary: $("me-f-salary").value.replace(/\D/g, ""), employer: $("me-f-employer").value.trim().slice(0, 60), city: $("me-f-city").value.trim().slice(0, 40)
    }).then(loadHome).then(function () {
      renderAccount();
      $("me-err").className = "saved-ok"; $("me-err").textContent = "Saved";
      setTimeout(function () { if ($("me-err").textContent === "Saved") $("me-err").textContent = ""; }, 1800);
    }).catch(function (err) { $("me-err").className = "err"; $("me-err").textContent = err.message; }).finally(function () { busy(btn, false); });
  });
  $("acc-add").addEventListener("click", openAddType);
  $("acc-cibil").addEventListener("click", openScore);
  $("svc-cibil").addEventListener("click", openScore);
  $("svc-add").addEventListener("click", openAddType);
  $("svc-ritu").addEventListener("click", openRitu);
  $("acc-privacy").addEventListener("click", function (e) { e.preventDefault(); location.href = "/privacy"; });
  $("to-admin").addEventListener("click", function () { customerView(false); if (window.SamvaadAdmin) window.SamvaadAdmin.start(); });
  function signOut() {
    customerView(false);
    if (window.SamvaadAdmin) window.SamvaadAdmin.stop();
    return api("POST", "/auth/logout").catch(function () {}).then(function () {
      try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf("sb-") === 0) localStorage.removeItem(k); }); } catch (e) {}
      chat = []; chatStarted = false; $("chat-log").textContent = ""; $("chat-suggest").hidden = false;
      $("id-input").value = "";
      goLogin();
    });
  }
  $("sign-out").addEventListener("click", signOut);

  // ---- wire the service tiles
  var SERVICES = { balance_transfer: openBtLoans, fresh_loan: openNlTypes, payoff_help: openPayoff, callback: openCallback };
  document.querySelectorAll("[data-service]").forEach(function (b) {
    b.addEventListener("click", function () { SERVICES[b.dataset.service](); });
  });
  $("h-saving-go").addEventListener("click", openBtLoans);

  // ---- Call us
  function fmtPhone(d) { return "+" + d.slice(0, 2) + " " + d.slice(2, 7) + " " + d.slice(7); }
  $("call-now").href = "tel:+" + SUPPORT_PHONE;
  $("call-wa").href = "https://wa.me/" + SUPPORT_PHONE;
  $("call-num").textContent = fmtPhone(SUPPORT_PHONE);
  function openCall() { $("call-sheet").hidden = false; requestAnimationFrame(function () { $("call-sheet").classList.add("open"); }); }
  function closeCall() { $("call-sheet").classList.remove("open"); setTimeout(function () { $("call-sheet").hidden = true; }, 200); }
  document.querySelectorAll("[data-call]").forEach(function (b) { b.addEventListener("click", openCall); });
  $("call-close").addEventListener("click", closeCall);
  $("call-sheet").addEventListener("click", function (e) { if (e.target === this) closeCall(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("call-sheet").hidden) closeCall(); });

  // refresh when the customer comes back to the app (so status changes from admin show up)
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && D && !$("screen-home").hidden) refreshHome();
  });

  // shared with the admin screens (admin.js)
  window.SV = {
    api: api, show: show, el: el, inr: inr, pct: pct, toast: toast, busy: busy, when: when, niceDate: niceDate,
    monthsText: monthsText, band: band, initials: initials, typeName: typeName,
    setHistory: function (h) { history_ = h; }, pushHistory: function (id) { history_.push(id); },
    data: function () { return D; }, signOut: signOut, openCall: openCall,
    customerView: function () { customerView(true); loadHome().then(function () { history_ = ["screen-home"]; openHome(); }); }
  };

  // ============================================================== start
  handleRecovery().then(function (done) {
    if (done) return;
    if (CFG.user) {
      loadHome().then(landing).catch(function () { goLogin(); });
    } else {
      goLogin();
    }
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(function () {});
})();
