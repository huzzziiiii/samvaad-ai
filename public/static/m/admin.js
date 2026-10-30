/* Samvaad admin mode inside the app. Only opens for admin emails; every
   call goes to /api/admin/*, which the server also locks to admins. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var SV = window.SV;
  if (!SV) return;
  var el = SV.el, inr = SV.inr, api = SV.api;

  var META = null, REQS = [], FEED = [], CUSTS = [], BANKS = [];
  var reqFilter = "new", feedFilter = "all", tab = "req";
  var seenFeed = "", seenReq = "", latest = "", poller = null;
  var STATUS_LABEL = { "new": "New", contacted: "Contacted", in_progress: "In progress", done: "Done", closed: "Closed" };
  var STATUS_PILL = { "new": "new", contacted: "progress", in_progress: "progress", done: "done", closed: "" };
  var KIND_NAME = { balance_transfer: "Lower my rate", fresh_loan: "New loan", payoff_help: "Close faster", callback: "Call me" };
  var EV_ICON = { signed_up: "★", signed_in: "→", details: "✎", loan_added: "+", loan_updated: "✎", loan_removed: "−",
                  cibil_score: "◔", cibil_report: "▤", ritu: "?", request: "!" };
  var FEED_GROUPS = [["all", "All", null], ["request", "Requests", ["request"]], ["loans", "Loans", ["loan_added", "loan_updated", "loan_removed"]],
                     ["cibil", "CIBIL", ["cibil_score", "cibil_report"]], ["ritu", "Ritu", ["ritu"]], ["people", "Sign-ups", ["signed_up", "signed_in", "details"]]];
  var PHONE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4h3l1.5 4.5-2.2 1.5a11 11 0 005 5l1.5-2.2L20 14.5v3a2 2 0 01-2 2A15.5 15.5 0 015 6a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  var WA_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4.5 19.5l1.2-3.6A8 8 0 1112 20a8 8 0 01-3.9-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  var MAIL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  function typeName(t) { return (META && META.loan_types[t]) || "Loan"; }
  function pct(x) { return SV.pct(x); }
  function ago(iso) {
    var t = new Date(iso); if (isNaN(t)) return "";
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    return SV.when(iso);
  }
  function digits(ph) { return (ph || "").replace(/\D/g, ""); }
  function waLink(ph, name) {
    var d = digits(ph); if (d.length === 10) d = "91" + d;
    var msg = "Hi" + (name ? " " + name.split(" ")[0] : "") + ", this is Samvaad. Following up on your request in the app.";
    return "https://wa.me/" + d + "?text=" + encodeURIComponent(msg);
  }
  function scoreClass(v) { return !v ? "" : v >= 700 ? "good" : v >= 650 ? "ok" : "low"; }
  function quickActions(phone, name) {
    var box = el("span", "qa");
    if (!phone) return box;
    var c = el("a", "call"); c.href = "tel:" + phone; c.innerHTML = PHONE_ICON; c.setAttribute("aria-label", "Call " + (name || ""));
    var w = el("a", "wa"); w.href = waLink(phone, name); w.target = "_blank"; w.rel = "noopener"; w.innerHTML = WA_ICON; w.setAttribute("aria-label", "WhatsApp " + (name || ""));
    [c, w].forEach(function (a) { a.addEventListener("click", function (e) { e.stopPropagation(); }); box.appendChild(a); });
    return box;
  }

  // ------------------------------------------------------------ summary
  function loadSummary() {
    return api("GET", "/api/admin/summary").then(function (d) {
      META = d;
      $("af-new").textContent = d.counts.new_requests;
      $("af-today").textContent = d.counts.active_today == null ? "—" : d.counts.active_today;
      $("af-cust").textContent = d.counts.customers;
      $("af-loans").textContent = d.counts.loans;
      $("af-ai").textContent = "Ritu's brain: " + d.ai + ". Data: " + (d.backend === "supabase" ? "Supabase" : "local test database") + ".";
    });
  }

  // ----------------------------------------------------------- requests
  function reqLine(r) {
    var d = r.details || {};
    if (r.kind === "balance_transfer" && d.loan) {
      var s = typeName(d.loan.type) + " " + inr(d.loan.outstanding) + " at " + pct(d.loan.rate) + (d.loan.lender ? " (" + d.loan.lender + ")" : "");
      if (d.offer) s += " → " + d.offer.bank + " from " + pct(d.offer.best.rate) + " · saves up to " + inr(d.offer.best.net_saving);
      return s;
    }
    if (r.kind === "fresh_loan") {
      var e = d.eligibility || {};
      return typeName(d.loan_type) + (d.amount_wanted ? ", wants " + d.amount_wanted : "") + (e.emi_room != null ? " · EMI room " + inr(e.emi_room) + "/month" : "");
    }
    if (r.kind === "payoff_help" && d.plan) return "Extra " + inr(d.plan.extra) + "/month · saves " + inr(d.plan.interest_saved) + ", " + d.plan.months_saved + " months sooner";
    if (r.kind === "callback") return [d.call_time, d.topic].filter(Boolean).join(" · ");
    return "";
  }
  function loadReqs() { return api("GET", "/api/admin/requests").then(function (d) { REQS = d.requests; renderReqFilters(); renderReqs(); }); }
  function renderReqFilters() {
    var f = $("ad-req-filters"); f.textContent = "";
    ["new", "contacted", "in_progress", "done", "closed", "all"].forEach(function (k) {
      var n = k === "all" ? REQS.length : REQS.filter(function (r) { return r.status === k; }).length;
      var b = el("button", "chip", k === "all" ? "All" : STATUS_LABEL[k]); b.type = "button";
      if (n) b.appendChild(el("span", "n", String(n)));
      b.setAttribute("aria-pressed", String(k === reqFilter));
      b.addEventListener("click", function () { reqFilter = k; renderReqFilters(); renderReqs(); });
      f.appendChild(b);
    });
  }
  function renderReqs() {
    var list = $("ad-req-list"); list.textContent = "";
    var rows = REQS.filter(function (r) { return reqFilter === "all" || r.status === reqFilter; });
    $("ad-req-empty").hidden = rows.length > 0;
    rows.forEach(function (r) {
      var li = el("li");
      var b = el("button", "ad-req" + (r.status === "new" ? " is-new" : "")); b.type = "button";
      var top = el("div", "ad-req-top");
      var who = el("div");
      who.appendChild(el("div", "ad-req-name", r.customer_name || r.customer_email || "Customer"));
      who.appendChild(el("div", "ad-req-kind", KIND_NAME[r.kind] || META.kinds[r.kind] || r.kind));
      top.appendChild(who);
      top.appendChild(el("span", "pill " + (STATUS_PILL[r.status] || ""), STATUS_LABEL[r.status] || r.status));
      b.appendChild(top);
      var line = reqLine(r); if (line) b.appendChild(el("p", "ad-req-line", line));
      if (r.details && r.details.note) b.appendChild(el("p", "ad-req-line", "“" + r.details.note + "”"));
      var foot = el("div", "ad-req-foot");
      foot.appendChild(el("span", "ad-when", ago(r.created_at) + (r.customer_phone ? " · " + r.customer_phone : "")));
      foot.appendChild(quickActions(r.customer_phone, r.customer_name));
      b.appendChild(foot);
      b.addEventListener("click", function () { openReq(r); });
      li.appendChild(b); list.appendChild(li);
    });
    var n = REQS.filter(function (r) { return r.status === "new"; }).length;
    $("ad-req-badge").textContent = n; $("ad-req-badge").hidden = !n;
  }

  var curReq = null;
  function openReq(r) {
    curReq = r;
    $("ar-title").textContent = KIND_NAME[r.kind] || META.kinds[r.kind] || "Request";
    var who = $("ar-who"); who.textContent = "";
    who.appendChild(el("b", null, r.customer_name || "No name"));
    who.appendChild(el("span", null, [r.customer_phone, r.customer_email].filter(Boolean).join(" · ")));
    if (r.customer_employer) who.appendChild(el("span", null, r.customer_employer));
    var act = $("ar-actions"); act.textContent = "";
    if (r.customer_phone) {
      var c = el("a", "call"); c.href = "tel:" + r.customer_phone; c.innerHTML = PHONE_ICON + "<span>Call</span>"; act.appendChild(c);
      var w = el("a", "wa"); w.href = waLink(r.customer_phone, r.customer_name); w.target = "_blank"; w.rel = "noopener"; w.innerHTML = WA_ICON + "<span>WhatsApp</span>"; act.appendChild(w);
    }
    if (r.customer_email) { var m = el("a", "mail"); m.href = "mailto:" + r.customer_email; m.innerHTML = MAIL_ICON; m.setAttribute("aria-label", "Email"); act.appendChild(m); }

    var sum = $("ar-summary"); sum.textContent = "";
    function row(k, v, big) { if (v == null || v === "") return; var d = el("div", "sum-row" + (big ? " sum-big" : "")); d.appendChild(el("span", null, k)); d.appendChild(el("b", null, String(v))); sum.appendChild(d); }
    var d = r.details || {};
    row("Received", SV.when(r.created_at));
    if (r.kind === "balance_transfer" && d.loan) {
      row("Loan", typeName(d.loan.type) + " · " + (d.loan.lender || "—"));
      row("Left to pay", inr(d.loan.outstanding)); row("Rate now", pct(d.loan.rate) + " · EMI " + inr(d.loan.emi));
      if (d.offer) { row("Move to", d.offer.bank + " from " + pct(d.offer.best.rate)); row("New EMI", "about " + inr(d.offer.best.new_emi));
        row("Fees counted", inr(d.offer.processing_fee + d.offer.foreclosure_charge)); row("Saving", "up to " + inr(d.offer.best.net_saving), true); }
    } else if (r.kind === "fresh_loan") {
      row("Loan", typeName(d.loan_type)); row("Amount", d.amount_wanted);
      var e = d.eligibility; if (e) { row("EMI room", inr(e.emi_room) + "/month"); if (e.offers && e.offers[0]) row("Best offer", e.offers[0].bank + ", up to " + inr(e.offers[0].max_amount)); }
    } else if (r.kind === "payoff_help" && d.plan) {
      row("Extra each month", inr(d.plan.extra)); row("Months sooner", d.plan.months_saved); row("Interest saved", inr(d.plan.interest_saved), true);
    } else if (r.kind === "callback") {
      row("Call", d.call_time || "Any time"); row("About", d.topic);
    }
    row("Salary", d.salary ? inr(d.salary) + "/month" : "not given");
    if (d.overview) row("All EMIs", inr(d.overview.total_emi) + (d.overview.emi_to_salary_pct != null ? " (" + d.overview.emi_to_salary_pct + "% of salary)" : ""));
    if (d.note) row("Customer's note", "“" + d.note + "”");

    var seg = $("ar-status"); seg.textContent = "";
    META.statuses.forEach(function (st) {
      var b = el("button", null, STATUS_LABEL[st] || st); b.type = "button"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(st === r.status));
      b.addEventListener("click", function () {
        if (st === r.status) return;
        api("PATCH", "/api/admin/requests/" + r.id, { status: st }).then(function () {
          r.status = st;
          seg.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); });
          SV.toast("Marked " + (STATUS_LABEL[st] || st).toLowerCase() + ". The customer's tracker is updated.");
          renderReqFilters(); renderReqs(); loadSummary();
        }).catch(function (err) { $("ar-err").textContent = err.message; });
      });
      seg.appendChild(b);
    });
    $("ar-note").value = r.admin_note || ""; $("ar-err").textContent = "";
    $("ar-open-cust").onclick = function () { openCustomer(r.user_id); };
    SV.show("screen-adm-req"); window.scrollTo(0, 0);
  }
  $("ar-save-note").addEventListener("click", function () {
    var btn = this; SV.busy(btn, true);
    api("PATCH", "/api/admin/requests/" + curReq.id, { note: $("ar-note").value }).then(function () {
      curReq.admin_note = $("ar-note").value; SV.toast("Note saved.");
    }).catch(function (err) { $("ar-err").textContent = err.message; }).finally(function () { SV.busy(btn, false); });
  });

  // ----------------------------------------------------------- activity
  function renderFeedFilters() {
    var f = $("ad-feed-filters"); f.textContent = "";
    FEED_GROUPS.forEach(function (g) {
      var b = el("button", "chip", g[1]); b.type = "button";
      b.setAttribute("aria-pressed", String(g[0] === feedFilter));
      b.addEventListener("click", function () { feedFilter = g[0]; renderFeedFilters(); renderFeed(); });
      f.appendChild(b);
    });
  }
  function evItem(e, withName, highlight) {
    var li = el("li", "ad-ev k-" + e.kind + (highlight && e.created_at > highlight ? " is-new" : ""));
    li.appendChild(el("span", "ad-ev-ico", EV_ICON[e.kind] || "•"));
    var body = el("div");
    var top = el("div", "ad-ev-top");
    var what = e.label || e.kind;
    if (withName) {
      var who = el("button", "ad-ev-who", e.customer_name || e.customer_email || "Customer"); who.type = "button";
      who.addEventListener("click", function () { openCustomer(e.user_id); });
      top.appendChild(who); top.appendChild(document.createTextNode(" "));
      what = what.charAt(0).toLowerCase() + what.slice(1);
    }
    top.appendChild(el("span", "ad-ev-what", what));
    body.appendChild(top);
    if (e.summary) body.appendChild(el("div", "ad-ev-sum", e.kind === "ritu" ? "“" + e.summary + "”" : e.summary));
    body.appendChild(el("div", "ad-ev-when", ago(e.created_at)));
    li.appendChild(body);
    return li;
  }
  var feedHighlight = "";
  function renderFeed() {
    var list = $("ad-feed"); list.textContent = "";
    var g = FEED_GROUPS.filter(function (x) { return x[0] === feedFilter; })[0];
    var rows = FEED.filter(function (e) { return !g[2] || g[2].indexOf(e.kind) !== -1; });
    $("ad-feed-empty").hidden = rows.length > 0;
    rows.forEach(function (e) { list.appendChild(evItem(e, true, feedHighlight)); });
    $("ad-feed-more").hidden = FEED.length < 60 || FEED.length % 60 !== 0;
  }
  $("ad-feed-more").addEventListener("click", function () {
    var last = FEED[FEED.length - 1]; if (!last) return;
    api("GET", "/api/admin/events?limit=60&before=" + encodeURIComponent(last.created_at)).then(function (d) { FEED = FEED.concat(d.events); renderFeed(); });
  });

  // poll every 20 s: new activity and new requests, with badges
  function poll() {
    return api("GET", "/api/admin/events?limit=60").then(function (d) {
      var newest = d.events[0] ? d.events[0].created_at : "";
      var hadRequest = latest && d.events.some(function (e) { return e.kind === "request" && e.created_at > latest; });
      if (!seenFeed) seenFeed = newest;
      if (tab === "act" && !$("screen-admin").hidden) { FEED = d.events; renderFeed(); seenFeed = newest; $("ad-act-badge").hidden = true; }
      else {
        var n = d.events.filter(function (e) { return e.created_at > seenFeed; }).length;
        $("ad-act-badge").textContent = n; $("ad-act-badge").hidden = !n;
      }
      if (newest > latest) latest = newest;
      if (hadRequest) {
        loadReqs(); loadSummary();
        SV.toast("New request just came in.");
        if (navigator.vibrate) try { navigator.vibrate(120); } catch (e) {}
      }
    }).catch(function () {});
  }

  // ---------------------------------------------------------- customers
  function loadCustomers() { return api("GET", "/api/admin/customers").then(function (d) { CUSTS = d.customers; renderCustomers(); }); }
  function renderCustomers() {
    var q = $("ad-cust-q").value.trim().toLowerCase(), ul = $("ad-cust-list"); ul.textContent = "";
    var rows = CUSTS.filter(function (c) { return !q || [c.name, c.email, c.phone, c.employer, c.city].join(" ").toLowerCase().indexOf(q) !== -1; });
    $("ad-cust-empty").hidden = rows.length > 0;
    $("ad-cust-count").textContent = CUSTS.length ? CUSTS.length + " total" : "";
    rows.forEach(function (c) {
      var li = el("li");
      var b = el("button", "ad-cust"); b.type = "button";
      b.appendChild(el("span", "ad-av", (c.name || c.email || "?").trim()[0].toUpperCase()));
      var body = el("span", "ad-cust-body");
      var nm = el("b", null, c.name || c.email || "No name");
      if (c.open_requests) nm.appendChild(el("span", "open-tag", c.open_requests + " open"));
      body.appendChild(nm);
      body.appendChild(el("span", null, [c.employer, c.phone || c.email].filter(Boolean).join(" · ") || "No details yet"));
      body.appendChild(el("span", null, c.loans + " loan" + (c.loans === 1 ? "" : "s") + (c.total_outstanding ? " · " + inr(c.total_outstanding) + " left" : "") + " · " + (c.last_seen ? ago(c.last_seen) : "")));
      b.appendChild(body);
      var right = el("span", "ad-cust-right");
      right.appendChild(el("span", "sc " + scoreClass(c.cibil_score), c.cibil_score ? String(c.cibil_score) : "—"));
      b.appendChild(right);
      b.addEventListener("click", function () { openCustomer(c.user_id); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  $("ad-cust-q").addEventListener("input", renderCustomers);

  function sec(title) { var s = el("section", "ac-sec"); s.appendChild(el("h2", null, title)); return s; }
  function kv(box, k, v) { if (v == null || v === "") v = "—"; var r = el("div", "kv"); r.appendChild(el("span", null, k)); r.appendChild(el("b", null, String(v))); box.appendChild(r); }

  function openCustomer(uid) {
    var body = $("ac-body"); body.textContent = "";
    body.appendChild(el("p", "empty", "Loading…"));
    SV.show("screen-adm-cust"); window.scrollTo(0, 0);
    api("GET", "/api/admin/customers/" + encodeURIComponent(uid)).then(function (c) {
      var p = c.profile, ov = c.overview || {};
      body.textContent = "";
      var head = el("div", "ac-head");
      head.appendChild(el("span", "me-avatar", (p.name || p.email || "?").trim()[0].toUpperCase()));
      var hb = el("div"); hb.appendChild(el("b", null, p.name || "No name")); hb.appendChild(el("span", null, [p.phone, p.email].filter(Boolean).join(" · ")));
      head.appendChild(hb); body.appendChild(head);
      var act = el("div", "ar-actions");
      if (p.phone) {
        var cl = el("a", "call"); cl.href = "tel:" + p.phone; cl.innerHTML = PHONE_ICON + "<span>Call</span>"; act.appendChild(cl);
        var w = el("a", "wa"); w.href = waLink(p.phone, p.name); w.target = "_blank"; w.rel = "noopener"; w.innerHTML = WA_ICON + "<span>WhatsApp</span>"; act.appendChild(w);
      }
      if (p.email) { var m = el("a", "mail"); m.href = "mailto:" + p.email; m.innerHTML = MAIL_ICON; m.setAttribute("aria-label", "Email"); act.appendChild(m); }
      if (act.childNodes.length) body.appendChild(act);

      var cs = sec("CIBIL");
      var sb = el("div", "ac-score");
      var ring = el("span", "score-ring " + (p.cibil_score ? SV.band(p.cibil_score)[1] : ""));
      ring.appendChild(el("span", null, p.cibil_score ? String(p.cibil_score) : "?"));
      sb.appendChild(ring);
      var st = el("div");
      st.appendChild(el("p", null, p.cibil_score ? SV.band(p.cibil_score)[0] + (p.cibil_date ? " · report " + SV.niceDate(p.cibil_date) : "") : "No score added yet"));
      if (p.has_report) {
        var a = el("a", null, "Open CIBIL report (PDF)");
        a.href = "/admin/customers/" + encodeURIComponent(uid) + "/report.pdf"; a.target = "_blank"; a.rel = "noopener";
        st.appendChild(a);
      } else st.appendChild(el("p", null, "No report uploaded"));
      sb.appendChild(st); cs.appendChild(sb); body.appendChild(cs);

      var ds = sec("Details");
      kv(ds, "Company", p.employer); kv(ds, "City", p.city); kv(ds, "Salary / month", p.salary ? inr(p.salary) : null);
      kv(ds, "EMIs take", ov.emi_to_salary_pct != null ? ov.emi_to_salary_pct + "% of salary" : null);
      kv(ds, "Joined", p.created_at ? SV.niceDate(p.created_at) : null); kv(ds, "Last active", p.last_seen ? ago(p.last_seen) : null);
      body.appendChild(ds);

      var ls = sec("Loans · " + (ov.count || 0) + (ov.count ? " · " + inr(ov.total_outstanding) + " left · EMI " + inr(ov.total_emi) : ""));
      (ov.loans || []).forEach(function (l) {
        var d = el("div", "ac-loan");
        var t = el("div", "ac-loan-top"); var n = el("span", null, typeName(l.type));
        if (l.source === "cibil") n.appendChild(el("span", "cibil-tag", "CIBIL"));
        t.appendChild(n); t.appendChild(el("span", null, inr(l.outstanding))); d.appendChild(t);
        d.appendChild(el("div", "ac-loan-meta", (l.lender || "—") + " · " + pct(l.rate) + " · EMI " + inr(l.emi) + (l.months_left ? " · " + SV.monthsText(l.months_left) + " left" : "")));
        ls.appendChild(d);
      });
      if (!(ov.loans || []).length) ls.appendChild(el("p", "empty", "No loans added yet."));
      var best = (c.transfers || []).filter(function (x) { return x.options && x.options.length; })
        .sort(function (a, b) { return b.options[0].best.net_saving - a.options[0].best.net_saving; })[0];
      if (best) {
        var o = best.options[0];
        ls.appendChild(el("p", "opp", "Opportunity: move their " + typeName(best.loan.type).toLowerCase() + " (" + (best.loan.lender || "—") + ", " + pct(best.loan.rate) + ") to " +
          o.bank + " from " + pct(o.best.rate) + ". Saves them up to " + inr(o.best.net_saving) + " after fees."));
      }
      body.appendChild(ls);

      var rs = sec("Requests · " + c.requests.length);
      c.requests.forEach(function (r) {
        r.customer_name = p.name; r.customer_phone = p.phone; r.customer_email = p.email; r.customer_employer = p.employer;
        var b = el("button", "ad-req" + (r.status === "new" ? " is-new" : "")); b.type = "button";
        var top = el("div", "ad-req-top"); top.appendChild(el("div", "ad-req-kind", KIND_NAME[r.kind] || r.kind));
        top.appendChild(el("span", "pill " + (STATUS_PILL[r.status] || ""), STATUS_LABEL[r.status] || r.status)); b.appendChild(top);
        var line = reqLine(r); if (line) b.appendChild(el("p", "ad-req-line", line));
        b.appendChild(el("p", "ad-when", ago(r.created_at)));
        b.addEventListener("click", function () { var full = REQS.filter(function (x) { return x.id === r.id; })[0] || r; openReq(full); });
        rs.appendChild(b);
      });
      if (!c.requests.length) rs.appendChild(el("p", "empty", "No requests yet."));
      body.appendChild(rs);

      var es = sec("Everything they've done");
      var ol = el("ol", "ad-feed");
      c.events.forEach(function (e) { ol.appendChild(evItem(e, false)); });
      es.appendChild(ol);
      if (!c.events.length) es.appendChild(el("p", "empty", "No activity yet."));
      body.appendChild(es);
    }).catch(function (err) { body.textContent = ""; body.appendChild(el("p", "err", err.message)); });
  }

  // -------------------------------------------------------------- banks
  var curBank = null;
  function loadBanks() { return api("GET", "/api/admin/banks").then(function (d) { BANKS = d.banks; renderBanks(); }); }
  function renderBanks() {
    var ul = $("ab-list"); ul.textContent = "";
    var byType = {};
    BANKS.forEach(function (b) { (byType[b.product] = byType[b.product] || []).push(b); });
    Object.keys(byType).forEach(function (t) {
      ul.appendChild(el("li", "list-label", typeName(t)));
      byType[t].forEach(function (b) {
        var li = el("li");
        var row = el("button", "ad-bank" + (b.active ? "" : " off") + (/^sample/i.test(b.name) ? " sample" : "")); row.type = "button";
        row.appendChild(el("span", "lender-mark", SV.initials(b.name)));
        var body = el("span", "ad-bank-body"); body.appendChild(el("b", null, b.name));
        body.appendChild(el("span", null, pct(b.rate_min) + (b.rate_max && b.rate_max !== b.rate_min ? " – " + pct(b.rate_max) : "") +
          " · fee " + pct(b.processing_fee_pct || 0) + (b.max_tenure_months ? " · up to " + b.max_tenure_months + " months" : "") + (b.active ? "" : " · hidden")));
        row.appendChild(body);
        row.addEventListener("click", function () { openBank(b); });
        li.appendChild(row); ul.appendChild(li);
      });
    });
    if (!BANKS.length) ul.appendChild(el("li", "empty", "No lenders yet. Add the banks you're tied up with."));
  }
  function openBank(b) {
    curBank = b || null;
    $("abf-title").textContent = b ? b.name : "Add a lender";
    var sel = $("abf-product"); sel.textContent = "";
    Object.keys(META.loan_types).forEach(function (k) { var o = el("option", null, META.loan_types[k]); o.value = k; sel.appendChild(o); });
    sel.value = b ? b.product : "personal";
    $("abf-name").value = b ? b.name : ""; $("abf-min").value = b ? b.rate_min : ""; $("abf-max").value = b && b.rate_max != null ? b.rate_max : "";
    $("abf-fee").value = b && b.processing_fee_pct != null ? b.processing_fee_pct : ""; $("abf-tenure").value = b && b.max_tenure_months ? b.max_tenure_months : "";
    $("abf-active").checked = b ? !!b.active : true; $("abf-err").textContent = "";
    $("abf-delete").hidden = !b;
    SV.show("screen-adm-bank"); window.scrollTo(0, 0);
  }
  $("ad-open-banks").addEventListener("click", function () { loadBanks().catch(function (e) { SV.toast(e.message); }); SV.show("screen-adm-banks"); window.scrollTo(0, 0); });
  $("ab-add").addEventListener("click", function () { openBank(null); });
  $("abf-save").addEventListener("click", function () {
    var body = { name: $("abf-name").value, product: $("abf-product").value, rate_min: $("abf-min").value, rate_max: $("abf-max").value,
                 processing_fee_pct: $("abf-fee").value, max_tenure_months: $("abf-tenure").value, active: $("abf-active").checked };
    var btn = this; SV.busy(btn, true);
    (curBank ? api("PUT", "/api/admin/banks/" + curBank.id, body) : api("POST", "/api/admin/banks", body)).then(function (d) {
      BANKS = d.banks; renderBanks(); SV.toast("Saved. Customers see the new rates straight away.");
      SV.setHistory(["screen-admin", "screen-adm-banks"]); SV.show("screen-adm-banks");
    }).catch(function (err) { $("abf-err").textContent = err.message; }).finally(function () { SV.busy(btn, false); });
  });
  $("abf-delete").addEventListener("click", function () {
    if (!curBank || !confirm("Delete " + curBank.name + " (" + typeName(curBank.product) + ")?")) return;
    api("DELETE", "/api/admin/banks/" + curBank.id).then(function (d) {
      BANKS = d.banks; renderBanks(); SV.setHistory(["screen-admin", "screen-adm-banks"]); SV.show("screen-adm-banks");
    }).catch(function (err) { $("abf-err").textContent = err.message; });
  });

  // --------------------------------------------------------------- tabs
  function openTab(name) {
    tab = name;
    ["req", "act", "cust", "more"].forEach(function (t) { $("atab-" + t).hidden = t !== name; });
    document.querySelectorAll("[data-atab]").forEach(function (b) { b.classList.toggle("is-on", b.dataset.atab === name); });
    if (name === "req") loadReqs().catch(function (e) { SV.toast(e.message); });
    if (name === "act") {
      feedHighlight = seenFeed;
      api("GET", "/api/admin/events?limit=60").then(function (d) {
        FEED = d.events; renderFeed();
        seenFeed = FEED[0] ? FEED[0].created_at : seenFeed; $("ad-act-badge").hidden = true;
      }).catch(function (e) { SV.toast(e.message); });
    }
    if (name === "cust") loadCustomers().catch(function (e) { SV.toast(e.message); });
    if (name === "more") loadSummary().catch(function () {});
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("[data-atab]").forEach(function (b) { b.addEventListener("click", function () { openTab(b.dataset.atab); }); });
  $("ad-customer-view").addEventListener("click", function () { SV.customerView(); });
  $("ad-sign-out").addEventListener("click", function () { SV.signOut(); });

  window.SamvaadAdmin = {
    start: function () {
      SV.setHistory(["screen-admin"]);
      SV.show("screen-admin");
      renderFeedFilters();
      loadSummary().then(function () { openTab(tab); return poll(); }).catch(function (e) { SV.toast(e.message); });
      if (!poller) poller = setInterval(function () { if (!document.hidden) poll(); }, 20000);
    },
    back: function () { SV.show("screen-admin"); if (tab === "req") renderReqs(); if (tab === "cust") loadCustomers().catch(function () {}); },
    stop: function () { if (poller) clearInterval(poller); poller = null; REQS = []; FEED = []; CUSTS = []; seenFeed = ""; latest = ""; }
  };
})();
