// Plays the hero call sheet once: lines arrive in order, the clock ticks,
// then the "Interested" stamp lands. Without JS or with reduced motion,
// the finished sheet is shown as-is.
(function () {
  var sheet = document.querySelector(".sheet");
  if (!sheet) return;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  var script = sheet.querySelector("#sheet-script");
  var stamp = sheet.querySelector(".sheet-stamp");
  var clock = sheet.querySelector("#sheet-clock");
  var items = Array.prototype.slice.call(script.children); // dt, dd, dt, dd...

  sheet.classList.add("is-animating");

  var seconds = 71;
  function paintClock() {
    if (!clock) return;
    var m = Math.floor(seconds / 60), s = seconds % 60;
    clock.textContent = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  paintClock();
  var tick = clock ? setInterval(function () { seconds += 1; paintClock(); }, 1000) : null;

  var t = 500;
  for (var i = 0; i < items.length; i += 2) {
    (function (dt, dd, at) {
      setTimeout(function () { dt.classList.add("is-in"); dd.classList.add("is-in"); }, at);
    })(items[i], items[i + 1], t);
    // longer lines take longer to "say"
    t += 450 + Math.min(1500, items[i + 1].textContent.length * 11);
  }

  setTimeout(function () {
    stamp.classList.add("is-in");
    if (tick) clearInterval(tick);
  }, t + 200);
})();
