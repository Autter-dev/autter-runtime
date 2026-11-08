// Autter Runtime dashboard — the only script. Pages are complete without
// it; this adds canvas charts, live refresh, filter auto-submit and
// hover prefetch. No dependencies, no build step.
(() => {
  "use strict";
  const $$ = (s, r = document) => r.querySelectorAll(s);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let tip;

  function nice(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function num(v, u) {
    if (u === "$") return "$" + (v < 0.01 && v > 0 ? v.toFixed(4) : v < 100 ? v.toFixed(2) : v.toFixed(0));
    if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(v * 100) / 100);
  }
  function stamp(sec, step, full) {
    const iso = new Date(sec * 1000).toISOString();
    if (full) return iso.slice(5, 16).replace("T", " ") + " UTC";
    return step >= 3600 ? iso.slice(5, 10) + " " + iso.slice(11, 16) : iso.slice(11, 16);
  }

  function parse(c) {
    if (c._d) return c._d;
    const series = c.dataset.s.split(";").map((s) => {
      const [label, vals] = s.split("|");
      return { label, v: vals.split(",").map((x) => (x ? +x : 0)) };
    });
    let max = 0;
    for (const s of series) for (const v of s.v) if (v > max) max = v;
    return (c._d = { series, max: nice(max), n: series[0].v.length, start: +c.dataset.start, step: +c.dataset.step, u: c.dataset.u });
  }

  function draw(c, hover = -1) {
    const d = parse(c);
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const L = 40, B = 18, T = 6, pw = w - L - 2, ph = h - B - T;
    const colors = [css("--c1"), css("--c2"), css("--c3")];
    g.font = "11px " + css("--mono");
    g.fillStyle = css("--dim");
    g.strokeStyle = css("--line");
    g.lineWidth = 1;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (let i = 0; i <= 2; i++) {
      const y = Math.round(T + ph - (ph * i) / 2) + 0.5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
      g.fillText(num((d.max * i) / 2, d.u), L - 6, y);
    }
    const bw = pw / d.n, gap = bw > 4 ? 1 : 0;
    if (hover >= 0) { g.fillStyle = css("--soft"); g.fillRect(L + hover * bw, T, bw, ph); }
    d.series.forEach((s, si) => {
      g.fillStyle = colors[si % 3];
      g.globalAlpha = si === 0 && d.series.length > 1 ? 0.85 : 1;
      for (let i = 0; i < d.n; i++) {
        const v = s.v[i];
        if (!v) continue;
        const bh = Math.max(1, (v / d.max) * ph);
        g.fillRect(L + i * bw + gap / 2, T + ph - bh, Math.max(1, bw - gap), bh);
      }
    });
    g.globalAlpha = 1;
    g.fillStyle = css("--dim");
    g.textBaseline = "top";
    const ticks = Math.max(2, Math.min(6, Math.floor(pw / 90)));
    for (let i = 0; i <= ticks; i++) {
      const idx = Math.round((i * d.n) / ticks);
      g.textAlign = i === 0 ? "left" : i === ticks ? "right" : "center";
      g.fillText(stamp(d.start + idx * d.step, d.step), L + (idx / d.n) * pw, T + ph + 5);
    }
    c._L = L; c._pw = pw;
  }

  function onMove(e) {
    const c = e.target, d = parse(c);
    const r = c.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left - c._L) / c._pw) * d.n);
    if (i < 0 || i >= d.n) return onLeave(e);
    if (c._h !== i) { c._h = i; draw(c, i); }
    tip = tip || document.body.appendChild(Object.assign(document.createElement("div"), { className: "tip" }));
    const colors = [css("--c1"), css("--c2"), css("--c3")];
    tip.innerHTML = "";
    const head = document.createElement("div");
    head.textContent = stamp(d.start + i * d.step, d.step, true);
    tip.appendChild(head);
    d.series.forEach((s, si) => {
      const row = document.createElement("div");
      const sw = document.createElement("i");
      sw.style.background = colors[si % 3];
      row.append(sw, s.label + ": " + num(s.v[i], d.u));
      tip.appendChild(row);
    });
    tip.style.display = "block";
    const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + "px";
    tip.style.top = e.clientY - tip.offsetHeight - 10 + "px";
  }
  function onLeave(e) {
    const c = e.target;
    if (c._h !== undefined && c._h !== -1) { c._h = -1; draw(c); }
    if (tip) tip.style.display = "none";
  }

  function charts() {
    for (const c of $$("canvas[data-s]")) {
      draw(c);
      if (!c._bound) {
        c._bound = true;
        c.addEventListener("mousemove", onMove);
        c.addEventListener("mouseleave", onLeave);
      }
    }
  }

  let rz;
  addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => $$("canvas[data-s]").forEach((c) => draw(c))); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => $$("canvas[data-s]").forEach((c) => draw(c)));

  // Filters: submit on change; repository picker navigates directly.
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("select[data-auto]")) t.form.submit();
    else if (t.matches("select[data-nav]")) location.href = t.value;
  });

  // Live mode: refetch this URL and swap <main> in place. Paused while the
  // tab is hidden or the user has something expanded.
  const sel = document.getElementById("refresh");
  let timer;
  function live(sec) {
    clearInterval(timer);
    if (sec > 0) timer = setInterval(refresh, sec * 1000);
  }
  async function refresh() {
    if (document.hidden || document.querySelector("main details[open]")) return;
    try {
      const res = await fetch(location.href, { credentials: "same-origin" });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const m = doc.getElementById("main"), rt = doc.getElementById("rt");
      if (!m) return;
      document.getElementById("main").replaceWith(document.adoptNode(m));
      if (rt) document.getElementById("rt").textContent = rt.textContent;
      charts();
    } catch (_) { /* transient; next tick retries */ }
  }
  if (sel) {
    let saved = "0";
    try { saved = localStorage.getItem("rt-live") || "0"; } catch (_) {}
    sel.value = saved;
    live(+saved);
    sel.addEventListener("change", () => {
      try { localStorage.setItem("rt-live", sel.value); } catch (_) {}
      live(+sel.value);
    });
  }

  // Hover-intent prefetch: by the time the click lands, the next page is
  // usually already in the browser cache.
  const fetched = new Set();
  let hov;
  document.addEventListener("mouseover", (e) => {
    const a = e.target.closest && e.target.closest("a[href^='/']");
    if (!a || fetched.has(a.href) || a.href === location.href) return;
    clearTimeout(hov);
    hov = setTimeout(() => {
      fetched.add(a.href);
      const l = document.createElement("link");
      l.rel = "prefetch"; l.href = a.href;
      document.head.appendChild(l);
    }, 90);
  });
  document.addEventListener("mouseout", () => clearTimeout(hov));

  // "/" focuses the search box.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const q = document.querySelector("input[type=search]");
    if (q) { e.preventDefault(); q.focus(); q.select(); }
  });

  charts();
  // Canvas text doesn't re-render when a web font loads; redraw once the
  // brand faces are in so axis labels use them on the very first visit.
  if (document.fonts) document.fonts.ready.then(() => $$("canvas[data-s]").forEach((c) => draw(c)));
})();
