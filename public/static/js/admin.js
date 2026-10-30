(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  function inr(n) { return n == null || n === "" ? "—" : "₹" + fmt.format(Math.round(Number(n))); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(method, path, body) {
    var o = { method: method, headers: {} };
    if (body !== undefined) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "Request failed"); return d; });
    });
  }

  var META = null, REQS = [], FILTER = "new";
  var STATUS_LABEL = { "new": "New", contacted: "Contacted", in_progress: "In progress", done: "Done", closed: "Closed" };

  // tabs
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".adm-tabs .tab"));
  tabs.forEach(function (t) {
    t.addEventListener("click", function () {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1;
        $(x.getAttribute("aria-controls")).hidden = !on;
      });
      if (t.id === "atab-banks") loadBanks();
      if (t.id === "atab-activity") { loadFeed().then(function () { seenUntil = latestEvent; }); $("act-badge").hidden = true; }
      if (t.id === "atab-customers") loadCustomers();
    });
  });

  // ------------------------------------------------------------ summary
  function loadSummary() {
    return api("GET", "/api/admin/summary").then(function (d) {
      META = d;
      $("c-new").textContent = d.counts.new_requests;
      $("c-today").textContent = d.counts.active_today == null ? "—" : d.counts.active_today;
      $("c-cust").textContent = d.counts.customers;
      $("c-loans").textContent = d.counts.loans;
      $("adm-sub").textContent = "Data: " + (d.backend === "supabase" ? "Supabase" : "local test database") + ". Ritu's brain: " + d.ai + ".";
      var f = $("status-filters"); f.textContent = "";
      ["new", "contacted", "in_progress", "done", "closed", "all"].forEach(function (s) {
        var b = el("button", "filter", s === "all" ? "All" : STATUS_LABEL[s]);
        b.type = "button"; b.setAttribute("aria-pressed", String(s === FILTER));
        b.addEventListener("click", function () { FILTER = s; loadSummary(); renderReqs(); });
        f.appendChild(b);
      });
      var sel = $("bank-product"); if (!sel.options.length) {
        Object.keys(d.loan_types).forEach(function (k) { var o = el("option", null, d.loan_types[k]); o.value = k; sel.appendChild(o); });
        sel.value = "personal";
      }
    });
  }

  // ----------------------------------------------------------- requests
  function loadReqs() {
    return api("GET", "/api/admin/requests").then(function (d) { REQS = d.requests; renderReqs(); });
  }

  function summaryLine(r) {
    var d = r.details || {};
    if (r.kind === "balance_transfer" && d.loan) {
      var s = (META.loan_types[d.loan.type] || d.loan.type) + " " + inr(d.loan.outstanding) + " at " + d.loan.rate + "%";
      if (d.offer) s += " → " + d.offer.bank + " from " + d.offer.best.rate + "%, saves up to " + inr(d.offer.best.net_saving) +
        (d.offer.cautious.net_saving > 0 ? " (at least " + inr(d.offer.cautious.net_saving) + ")" : "");
      return s;
    }
    if (r.kind === "fresh_loan") {
      var e = d.eligibility || {};
      var t = (META.loan_types[d.loan_type] || "Loan");
      return t + (d.amount_wanted ? ", wants " + inr(String(d.amount_wanted).replace(/[^0-9.]/g, "")) : "") +
        (e.emi_room != null ? ". EMI room " + inr(e.emi_room) + "/month" : "");
    }
    if (r.kind === "callback") {
      return [d.call_time, d.topic].filter(Boolean).join(" · ");
    }
    if (r.kind === "payoff_help" && d.plan) {
      return "Extra " + inr(d.plan.extra) + "/month saves " + inr(d.plan.interest_saved) + ", " + d.plan.months_saved + " months sooner";
    }
    return "";
  }

  function renderReqs() {
    var list = $("adm-reqs"); list.textContent = "";
    var rows = REQS.filter(function (r) { return FILTER === "all" || r.status === FILTER; });
    $("adm-reqs-empty").hidden = rows.length > 0;
    rows.forEach(function (r) {
      var d = r.details || {};
      var li = el("li", "adm-req");
      var head = el("div", "adm-req-head");
      var who = el("div");
      who.appendChild(el("p", "adm-req-name", (r.customer_name || "No name") + (r.customer_employer ? ", " + r.customer_employer : "")));
      var contact = el("p", "adm-req-contact");
      if (r.customer_phone) { var a = el("a", null, r.customer_phone); a.href = "tel:" + r.customer_phone; contact.appendChild(a); contact.appendChild(document.createTextNode("  ")); }
      if (r.customer_email) contact.appendChild(document.createTextNode(r.customer_email));
      who.appendChild(contact);
      var view = el("button", "linkish adm-view", "View customer →");
      view.type = "button";
      view.addEventListener("click", function () { openCustomer(r.user_id); });
      who.appendChild(view);
      head.appendChild(who);

      var sel = el("select", "adm-status");
      sel.setAttribute("aria-label", "Status");
      META.statuses.forEach(function (s) { var o = el("option", null, STATUS_LABEL[s] || s); o.value = s; if (s === r.status) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", function () {
        api("PATCH", "/api/admin/requests/" + r.id, { status: sel.value }).then(function () { r.status = sel.value; loadSummary(); })
          .catch(function (err) { alert(err.message); });
      });
      head.appendChild(sel);
      li.appendChild(head);

      var when = new Date(r.created_at);
      li.appendChild(el("p", "adm-req-kind", (META.kinds[r.kind] || r.kind) + (isNaN(when) ? "" : ", " + when.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))));
      var line = summaryLine(r);
      if (line) li.appendChild(el("p", "adm-req-line", line));
      if (d.note) li.appendChild(el("p", "adm-req-note", "“" + d.note + "”"));

      var more = el("details", "adm-more");
      more.appendChild(el("summary", null, "Loans, salary and your notes"));
      var dl = el("table", "mini");
      var tb = el("tbody");
      (d.loans || []).forEach(function (l) {
        var tr = el("tr");
        [META.loan_types[l.type] || l.type, l.lender || "—", inr(l.outstanding), l.rate + "%", inr(l.emi) + "/mo"].forEach(function (c) { tr.appendChild(el("td", null, c)); });
        tb.appendChild(tr);
      });
      dl.appendChild(tb);
      more.appendChild(dl);
      more.appendChild(el("p", "adm-req-line", "Salary: " + (d.salary ? inr(d.salary) + "/month" : "not given") +
        (d.overview ? ". Total EMI " + inr(d.overview.total_emi) + (d.overview.emi_to_salary_pct != null ? " (" + d.overview.emi_to_salary_pct + "% of salary)" : "") : "")));
      var note = el("textarea", "adm-note");
      note.rows = 2; note.placeholder = "Your notes (only you see these)"; note.value = r.admin_note || "";
      var save = el("button", "btn btn-quiet btn-small", "Save note");
      save.type = "button";
      save.addEventListener("click", function () {
        api("PATCH", "/api/admin/requests/" + r.id, { note: note.value }).then(function () { save.textContent = "Saved"; setTimeout(function () { save.textContent = "Save note"; }, 1500); })
          .catch(function (err) { alert(err.message); });
      });
      more.appendChild(note);
      more.appendChild(save);
      li.appendChild(more);
      list.appendChild(li);
    });
  }

  // -------------------------------------------------------------- banks
  function loadBanks() {
    api("GET", "/api/admin/banks").then(function (d) { renderBanks(d.banks); }).catch(function (err) { $("bank-msg").textContent = err.message; });
  }

  function renderBanks(banks) {
    var body = $("bank-rows"); body.textContent = "";
    banks.forEach(function (b) {
      var tr = el("tr");
      function cell(name, value, type) {
        var td = el("td");
        var inp = el(type === "select" ? "select" : "input");
        inp.name = name;
        inp.setAttribute("aria-label", name.replace(/_/g, " "));
        if (type === "select") {
          Object.keys(META.loan_types).forEach(function (k) { var o = el("option", null, META.loan_types[k]); o.value = k; if (k === value) o.selected = true; inp.appendChild(o); });
        } else if (type === "checkbox") {
          inp.type = "checkbox"; inp.checked = !!value;
        } else {
          inp.value = value == null ? "" : value;
          if (type === "num") inp.inputMode = "decimal";
        }
        td.appendChild(inp); tr.appendChild(td);
        return inp;
      }
      var f = {
        name: cell("name", b.name), product: cell("product", b.product, "select"),
        rate_min: cell("rate_min", b.rate_min, "num"), rate_max: cell("rate_max", b.rate_max, "num"),
        processing_fee_pct: cell("processing_fee_pct", b.processing_fee_pct, "num"),
        max_tenure_months: cell("max_tenure_months", b.max_tenure_months, "num"),
        active: cell("active", b.active, "checkbox")
      };
      var td = el("td", "bank-actions");
      var save = el("button", "btn btn-quiet btn-small", "Save");
      save.type = "button";
      save.addEventListener("click", function () {
        var body = {}; Object.keys(f).forEach(function (k) { body[k] = k === "active" ? f[k].checked : f[k].value; });
        api("PUT", "/api/admin/banks/" + b.id, body).then(function (d) { renderBanks(d.banks); $("bank-msg").textContent = ""; })
          .catch(function (err) { $("bank-msg").textContent = err.message; });
      });
      var del = el("button", "btn btn-quiet btn-small btn-danger-quiet", "Delete");
      del.type = "button";
      del.addEventListener("click", function () {
        if (!confirm("Delete " + b.name + " (" + (META.loan_types[b.product] || b.product) + ")?")) return;
        api("DELETE", "/api/admin/banks/" + b.id).then(function (d) { renderBanks(d.banks); });
      });
      td.appendChild(save); td.appendChild(del); tr.appendChild(td);
      if (/^sample/i.test(b.name)) tr.classList.add("is-sample");
      body.appendChild(tr);
    });
  }

  $("bank-add").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target, body = {};
    ["name", "product", "rate_min", "rate_max", "processing_fee_pct", "max_tenure_months"].forEach(function (k) { body[k] = form[k].value; });
    api("POST", "/api/admin/banks", body).then(function (d) { renderBanks(d.banks); form.reset(); $("bank-msg").textContent = "Lender added."; })
      .catch(function (err) { $("bank-msg").textContent = err.message; });
  });

  // ----------------------------------------------------------- activity
  var FEED = [], FEED_FILTER = "all", latestEvent = "", seenUntil = "";
  var FEED_GROUPS = {
    all: ["All", null],
    request: ["Requests", ["request"]],
    loans: ["Loans", ["loan_added", "loan_updated", "loan_removed"]],
    cibil: ["CIBIL", ["cibil_score", "cibil_report"]],
    ritu: ["Ritu", ["ritu"]],
    people: ["Sign-ups", ["signed_up", "signed_in", "details"]]
  };
  var EVENT_ICON = { signed_up: "★", signed_in: "→", details: "✎", loan_added: "+", loan_updated: "✎", loan_removed: "−",
                     cibil_score: "◔", cibil_report: "▤", ritu: "?", request: "!" };

  function ago(iso) {
    var t = new Date(iso); if (isNaN(t)) return "";
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    return t.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  function renderFeedFilters() {
    var f = $("feed-filters"); f.textContent = "";
    Object.keys(FEED_GROUPS).forEach(function (k) {
      var b = el("button", "filter", FEED_GROUPS[k][0]); b.type = "button";
      b.setAttribute("aria-pressed", String(k === FEED_FILTER));
      b.addEventListener("click", function () { FEED_FILTER = k; renderFeedFilters(); renderFeed(); });
      f.appendChild(b);
    });
  }

  function feedItem(e, withName) {
    var li = el("li", "feed-item kind-" + e.kind + (e.created_at > seenUntil && seenUntil ? " is-new" : ""));
    li.appendChild(el("span", "feed-ico", EVENT_ICON[e.kind] || "•"));
    var body = el("div", "feed-body");
    var top = el("p", "feed-top");
    if (withName) {
      var who = el("button", "linkish feed-who", e.customer_name || e.customer_email || "Customer");
      who.type = "button";
      who.addEventListener("click", function () { openCustomer(e.user_id); });
      top.appendChild(who);
      top.appendChild(document.createTextNode(" "));
    }
    var what = e.label || e.kind;
    top.appendChild(el("span", "feed-what", withName ? what.charAt(0).toLowerCase() + what.slice(1) : what));
    body.appendChild(top);
    if (e.summary) body.appendChild(el("p", "feed-sum", e.kind === "ritu" ? "“" + e.summary + "”" : e.summary));
    li.appendChild(body);
    var when = el("time", "feed-when", ago(e.created_at)); when.dateTime = e.created_at; when.title = new Date(e.created_at).toLocaleString("en-IN");
    li.appendChild(when);
    return li;
  }

  function renderFeed() {
    var list = $("feed"); list.textContent = "";
    var kinds = FEED_GROUPS[FEED_FILTER][1];
    var rows = FEED.filter(function (e) { return !kinds || kinds.indexOf(e.kind) !== -1; });
    $("feed-empty").hidden = rows.length > 0;
    rows.forEach(function (e) { list.appendChild(feedItem(e, true)); });
    $("feed-more").hidden = FEED.length < 60 || FEED.length % 60 !== 0;
  }

  function loadFeed(older) {
    var q = "/api/admin/events?limit=60" + (older && FEED.length ? "&before=" + encodeURIComponent(FEED[FEED.length - 1].created_at) : "");
    return api("GET", q).then(function (d) {
      FEED = older ? FEED.concat(d.events) : d.events;
      if (FEED.length) latestEvent = FEED[0].created_at > latestEvent ? FEED[0].created_at : latestEvent;
      renderFeed();
    });
  }
  $("feed-more").addEventListener("click", function () { loadFeed(true); });

  // poll for new activity, and badge the tab when it's not open
  function poll() {
    return api("GET", "/api/admin/events?limit=60").then(function (d) {
      var newest = d.events[0] ? d.events[0].created_at : "";
      if (!seenUntil) seenUntil = newest;
      var newRequest = latestEvent && d.events.some(function (e) { return e.kind === "request" && e.created_at > latestEvent; });
      if (!$("apanel-activity").hidden) {
        FEED = d.events; renderFeed(); seenUntil = newest; $("act-badge").hidden = true;
      } else {
        var n = d.events.filter(function (e) { return e.created_at > seenUntil; }).length;
        $("act-badge").textContent = n; $("act-badge").hidden = n === 0;
      }
      if (newRequest) { loadSummary(); loadReqs(); }
      if (newest > latestEvent) latestEvent = newest;
    }).catch(function () {});
  }
  setInterval(poll, 20000);

  // ---------------------------------------------------------- customers
  var CUSTS = [];
  function loadCustomers() {
    return api("GET", "/api/admin/customers").then(function (d) { CUSTS = d.customers; renderCustomers(); });
  }
  function scoreClass(v) { return !v ? "" : v >= 750 ? "s-good" : v >= 700 ? "s-ok" : v >= 650 ? "s-fair" : "s-low"; }
  function renderCustomers() {
    var q = $("cust-q").value.trim().toLowerCase(), body = $("cust-rows"); body.textContent = "";
    var rows = CUSTS.filter(function (c) {
      return !q || [c.name, c.email, c.phone, c.employer, c.city].join(" ").toLowerCase().indexOf(q) !== -1;
    });
    $("cust-empty").hidden = rows.length > 0;
    rows.forEach(function (c) {
      var tr = el("tr", "cust-row"); tr.tabIndex = 0;
      var who = el("td");
      who.appendChild(el("b", null, c.name || "No name"));
      who.appendChild(el("span", "cust-sub", [c.phone, c.email].filter(Boolean).join(" · ")));
      if (c.employer) who.appendChild(el("span", "cust-sub", c.employer + (c.city ? ", " + c.city : "")));
      tr.appendChild(who);
      var sc = el("td"); sc.appendChild(el("span", "score-chip " + scoreClass(c.cibil_score), c.cibil_score || "—"));
      if (c.has_report) sc.appendChild(el("span", "cust-sub", "report ✓"));
      tr.appendChild(sc);
      tr.appendChild(el("td", null, String(c.loans)));
      tr.appendChild(el("td", null, c.total_outstanding ? inr(c.total_outstanding) : "—"));
      tr.appendChild(el("td", null, c.total_emi ? inr(c.total_emi) : "—"));
      tr.appendChild(el("td", null, c.salary ? inr(c.salary) : "—"));
      var rq = el("td", null, String(c.requests));
      if (c.open_requests) rq.appendChild(el("span", "cust-sub open", c.open_requests + " open"));
      tr.appendChild(rq);
      tr.appendChild(el("td", "cust-when", c.last_seen ? ago(c.last_seen) : "—"));
      function go() { openCustomer(c.user_id); }
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      body.appendChild(tr);
    });
  }
  $("cust-q").addEventListener("input", renderCustomers);

  // ------------------------------------------------------ one customer
  function section(title) { var s = el("section", "cd-sec"); s.appendChild(el("h3", null, title)); return s; }
  function kv(label, value) { var r = el("div", "cd-kv"); r.appendChild(el("span", null, label)); r.appendChild(el("b", null, value == null || value === "" ? "—" : String(value))); return r; }

  function openCustomer(uid) {
    var dlg = $("cust-dialog"), body = $("cd-body");
    $("cd-name").textContent = "Loading…"; $("cd-contact").textContent = ""; body.textContent = "";
    if (!dlg.open) dlg.showModal();
    api("GET", "/api/admin/customers/" + encodeURIComponent(uid)).then(function (c) {
      var p = c.profile, ov = c.overview || {};
      $("cd-name").textContent = p.name || p.email || "Customer";
      var contact = $("cd-contact"); contact.textContent = "";
      if (p.phone) { var a = el("a", null, p.phone); a.href = "tel:" + p.phone; contact.appendChild(a); contact.appendChild(document.createTextNode("  ·  ")); }
      if (p.email) { var m = el("a", null, p.email); m.href = "mailto:" + p.email; contact.appendChild(m); }

      var top = el("div", "cd-grid");
      var who = section("Details");
      who.appendChild(kv("Company", p.employer)); who.appendChild(kv("City", p.city));
      who.appendChild(kv("Salary / month", p.salary ? inr(p.salary) : null));
      who.appendChild(kv("EMI share of salary", ov.emi_to_salary_pct != null ? ov.emi_to_salary_pct + "%" : null));
      who.appendChild(kv("Joined", p.created_at ? new Date(p.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : null));
      top.appendChild(who);

      var cb = section("CIBIL");
      var big = el("p", "cd-score " + scoreClass(p.cibil_score), p.cibil_score || "Not added");
      cb.appendChild(big);
      if (p.cibil_date) cb.appendChild(el("p", "cd-muted", "Report date " + new Date(p.cibil_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })));
      if (p.has_report) {
        var link = el("a", "btn btn-quiet btn-small", "Open CIBIL report (PDF)");
        link.href = "/admin/customers/" + encodeURIComponent(uid) + "/report.pdf"; link.target = "_blank"; link.rel = "noopener";
        cb.appendChild(link);
      } else cb.appendChild(el("p", "cd-muted", "No report uploaded"));
      top.appendChild(cb);
      body.appendChild(top);

      var ls = section("Loans · " + (ov.count || 0) + " · " + inr(ov.total_outstanding || 0) + " left · EMI " + inr(ov.total_emi || 0) + "/month");
      var t = el("table", "mini"), tb = el("tbody");
      (ov.loans || []).forEach(function (l) {
        var tr = el("tr");
        var name = el("td"); name.appendChild(document.createTextNode(META.loan_types[l.type] || l.type));
        if (l.source === "cibil") name.appendChild(el("span", "src-tag", "CIBIL"));
        tr.appendChild(name);
        [l.lender || "—", inr(l.outstanding), l.rate + "%", inr(l.emi) + "/mo", l.months_left ? Math.floor(l.months_left / 12) + "y " + (l.months_left % 12) + "m left" : "—"].forEach(function (v) { tr.appendChild(el("td", null, v)); });
        tb.appendChild(tr);
      });
      if (!(ov.loans || []).length) { var tr0 = el("tr"); tr0.appendChild(el("td", null, "No loans added yet")); tb.appendChild(tr0); }
      t.appendChild(tb); ls.appendChild(t);
      var best = (c.transfers || []).filter(function (x) { return x.options && x.options.length; });
      if (best.length) {
        var o = best[0].options[0], lo = best[0].loan;
        ls.appendChild(el("p", "cd-opportunity", "Opportunity: move " + (META.loan_types[lo.type] || "loan") + " (" + (lo.lender || "—") + ", " + lo.rate + "%) to " + o.bank +
          " from " + o.best.rate + "% · saves " + (o.cautious.net_saving > 0 ? inr(o.cautious.net_saving) + "–" : "up to ") + inr(o.best.net_saving)));
      }
      body.appendChild(ls);

      var rs = section("Requests");
      if (!c.requests.length) rs.appendChild(el("p", "cd-muted", "No requests yet"));
      c.requests.forEach(function (r) {
        var row = el("div", "cd-req");
        row.appendChild(el("b", null, META.kinds[r.kind] || r.kind));
        row.appendChild(el("span", "pill-s st-" + r.status, STATUS_LABEL[r.status] || r.status));
        row.appendChild(el("span", "cd-muted", ago(r.created_at)));
        var line = summaryLine(r); if (line) row.appendChild(el("p", "cd-line", line));
        if (r.details && r.details.note) row.appendChild(el("p", "cd-line", "“" + r.details.note + "”"));
        rs.appendChild(row);
      });
      body.appendChild(rs);

      var es = section("Everything they've done");
      var ol = el("ol", "feed feed-compact");
      c.events.forEach(function (e) { ol.appendChild(feedItem(e, false)); });
      if (!c.events.length) es.appendChild(el("p", "cd-muted", "No activity yet"));
      es.appendChild(ol);
      body.appendChild(es);
    }).catch(function (err) { $("cd-name").textContent = "Couldn't load"; body.appendChild(el("p", "form-msg", err.message)); });
  }
  $("cd-close").addEventListener("click", function () { $("cust-dialog").close(); });
  $("cust-dialog").addEventListener("click", function (e) { if (e.target === this) this.close(); });

  renderFeedFilters();
  loadSummary().then(loadReqs).then(poll).catch(function (err) { $("adm-sub").textContent = err.message; });
})();
