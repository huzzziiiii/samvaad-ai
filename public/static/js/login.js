(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("auth-config").textContent);
  var msg = document.getElementById("auth-msg");
  var next = window.SAMVAAD_NEXT || "";

  function say(text, bad) {
    msg.textContent = text || "";
    msg.classList.toggle("is-bad", !!bad);
  }

  function startSession(body) {
    body.next = next;
    return fetch("/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || "Couldn't sign you in.");
        location.href = d.next || "/app";
      });
    });
  }

  // ------------------------------------------------------- local test mode
  var local = document.getElementById("local-form");
  if (local) {
    local.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = local.email.value.trim();
      if (email.indexOf("@") < 1) { say("Enter a valid email address.", true); local.email.focus(); return; }
      say("Signing you in…");
      startSession({ email: email, name: local.name.value.trim() }).catch(function (err) { say(err.message, true); });
    });
    return;
  }

  if (config.mode !== "supabase" || !window.supabase) return;

  // ------------------------------------------------------------ Supabase
  var sb = window.supabase.createClient(config.supabase_url, config.supabase_anon_key, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" }
  });
  window.samvaadSupabase = sb;

  var form = document.getElementById("email-form");
  var nameField = document.getElementById("name-field");
  var submit = document.getElementById("email-submit");
  var switchBtn = document.getElementById("switch-mode");
  var switchText = document.getElementById("switch-text");
  var signingUp = false;

  function setMode(up) {
    signingUp = up;
    nameField.hidden = !up;
    submit.textContent = up ? "Create account" : "Sign in";
    form.password.autocomplete = up ? "new-password" : "current-password";
    switchText.textContent = up ? "Already have an account?" : "New to Samvaad?";
    switchBtn.textContent = up ? "Sign in" : "Create an account";
    say("");
  }
  switchBtn.addEventListener("click", function () { setMode(!signingUp); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = form.email.value.trim(), password = form.password.value;
    if (email.indexOf("@") < 1) { say("Enter a valid email address.", true); return; }
    if (password.length < 8) { say("Use a password of at least 8 characters.", true); return; }
    submit.disabled = true;
    say(signingUp ? "Creating your account…" : "Signing you in…");
    var p = signingUp
      ? sb.auth.signUp({ email: email, password: password, options: { data: { full_name: form.name.value.trim() } } })
      : sb.auth.signInWithPassword({ email: email, password: password });
    p.then(function (res) {
      if (res.error) throw new Error(res.error.message);
      var session = res.data && res.data.session;
      if (!session) {
        say("Check your email and tap the confirmation link, then sign in here.");
        setMode(false);
        return;
      }
      return startSession({ access_token: session.access_token });
    }).catch(function (err) {
      say(err.message || "Couldn't sign you in.", true);
    }).finally(function () { submit.disabled = false; });
  });

  var google = document.getElementById("google-btn");
  if (google) {
    google.addEventListener("click", function () {
      sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + "/login" + (next ? "?next=" + encodeURIComponent(next) : "") } });
    });
  }

  // Coming back from Google: Supabase puts the session in the URL.
  if (/[?&#](code|access_token)=/.test(location.href)) {
    say("Finishing sign-in…");
    sb.auth.getSession().then(function (res) {
      var s = res.data && res.data.session;
      if (s) return startSession({ access_token: s.access_token });
      say("That sign-in didn't complete. Try again.", true);
    }).catch(function (err) { say(err.message, true); });
  }
})();
