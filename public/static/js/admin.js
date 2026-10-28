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
    });
  });

  // ------------------------------------------------------------ summary
  function loadSummary() {
    return api("GET", "/api/admin/summary").then(function (d) {
      META = d;
      $("c-new").textContent = d.counts.new_requests;
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
      if (d.offer) s += " → " + d.offer.bank + " from " + d.offer.best.rate + "%, saves " + inr(d.offer.best.net_saving) + " (at least " + inr(d.offer.cautious.net_saving) + ")";
      return s;
    }
    if (r.kind === "fresh_loan") {
      var e = d.eligibility || {};
      var t = (META.loan_types[d.loan_type] || "Loan");
      return t + (d.amount_wanted ? ", wants " + inr(String(d.amount_wanted).replace(/[^0-9.]/g, "")) : "") +
        (e.emi_room != null ? ". EMI room " + inr(e.emi_room) + "/month" : "");
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

  loadSummary().then(loadReqs).catch(function (err) { $("adm-sub").textContent = err.message; });
})();
