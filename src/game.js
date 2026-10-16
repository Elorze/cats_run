(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });

  /** @type {Record<string, HTMLImageElement>} */
  const img = {};
  let ready = false;

  // Logical CSS pixel size (fills the phone screen)
  let VW = 390;
  let VH = 694;

  const meta = window.TRACK_META || { width: 720, height: 1291, path: [], finishIndex: 0, startIndex: 0 };
  const PATH = (meta.path || []).map((p) => ({ x: p[0], y: p[1] }));
  const WORLD_W = meta.width || 720;
  const WORLD_H = meta.height || 1291;

  // Offscreen track for pixel sampling (on-road test)
  const sampleCanvas = document.createElement("canvas");
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  let sampleReady = false;

  // ---- Audio ----
  let actx = null;
  let master = null;
  function ensureAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.2;
      master.connect(actx.destination);
    }
    if (actx.state === "suspended") actx.resume();
  }
  function beep(freq, dur, type, vol) {
    if (!actx || !master) return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // ---- Input ----
  const keys = new Set();
  let holdL = false;
  let holdR = false;
  const pointers = new Map();

  function wantLeft() {
    return holdL || keys.has("L");
  }
  function wantRight() {
    return holdR || keys.has("R");
  }

  function bindInput() {
    window.addEventListener(
      "keydown",
      (e) => {
        ensureAudio();
        if (["ArrowLeft", "a", "A"].includes(e.key)) keys.add("L");
        if (["ArrowRight", "d", "D"].includes(e.key)) keys.add("R");
        if ((e.key === " " || e.key === "Enter") && state.phase !== "race") startRace();
        e.preventDefault();
      },
      { passive: false }
    );
    window.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "a", "A"].includes(e.key)) keys.delete("L");
      if (["ArrowRight", "d", "D"].includes(e.key)) keys.delete("R");
    });

    const onDown = (e) => {
      ensureAudio();
      canvas.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      updateHolds();
      if (state.phase === "title" || state.phase === "done" || state.phase === "crash") startRace();
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      updateHolds();
      e.preventDefault();
    };
    const onUp = (e) => {
      pointers.delete(e.pointerId);
      updateHolds();
    };
    canvas.addEventListener("pointerdown", onDown, { passive: false });
    canvas.addEventListener("pointermove", onMove, { passive: false });
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  function updateHolds() {
    holdL = false;
    holdR = false;
    for (const p of pointers.values()) {
      const x = (p.x / window.innerWidth) * VW;
      if (x < VW * 0.5) holdL = true;
      else holdR = true;
    }
  }

  // ---- Path helpers ----
  function pathTangent(i) {
    const a = PATH[i];
    const b = PATH[(i + 1) % (PATH.length - 1)] || PATH[0];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  function nearestPathIndex(x, y) {
    let best = 0;
    let bestD = 1e18;
    const n = PATH.length - 1;
    for (let i = 0; i < n; i++) {
      const p = PATH[i];
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function progressOf(idx) {
    const n = PATH.length - 1;
    return ((idx % n) + n) % n;
  }

  // ---- Game state ----
  const state = {
    phase: "title", // title | countdown | race | crash | done
    countdown: 0,
    time: 0,
    best: Number(localStorage.getItem("meowdrift_best") || 0) || 0,
    x: 0,
    y: 0,
    angle: -Math.PI / 2,
    speed: 0,
    pathIdx: 0,
    lapProgress: 0,
    crossedFinish: false,
    trails: [],
    shake: 0,
    message: "",
    messageT: 0,
    offRoadT: 0,
  };

  function resetCar() {
    const si = meta.startIndex || 0;
    const p = PATH[si] || { x: WORLD_W * 0.8, y: WORLD_H * 0.5 };
    const t = pathTangent(si);
    state.x = p.x;
    state.y = p.y;
    state.angle = Math.atan2(t.y, t.x);
    state.speed = 0;
    state.pathIdx = si;
    state.lapProgress = progressOf(si);
    state.crossedFinish = false;
    state.trails = [];
    state.time = 0;
    state.offRoadT = 0;
    state._vx = 0;
    state._vy = 0;
    state._traveled = 0;
  }

  function startRace() {
    ensureAudio();
    resetCar();
    state.phase = "countdown";
    state.countdown = 3.2;
    state.message = "";
    beep(440, 0.08, "triangle", 0.1);
  }

  function onCrash() {
    state.phase = "crash";
    state.message = "出界啦 — 点屏幕重开";
    state.messageT = 2;
    state.shake = 0.25;
    beep(140, 0.2, "sawtooth", 0.12);
  }

  function onFinish() {
    state.phase = "done";
    state.message = "冲线！";
    state.messageT = 3;
    if (!state.best || state.time < state.best) {
      state.best = state.time;
      localStorage.setItem("meowdrift_best", String(state.best));
    }
    beep(523, 0.1, "sine", 0.14);
    setTimeout(() => beep(659, 0.1, "sine", 0.14), 80);
    setTimeout(() => beep(784, 0.18, "triangle", 0.16), 160);
  }

  // ---- On-track sampling ----
  function isOnTrack(wx, wy) {
    if (!sampleReady) return true;
    const x = Math.round(wx);
    const y = Math.round(wy);
    if (x < 0 || y < 0 || x >= sampleCanvas.width || y >= sampleCanvas.height) return false;
    const d = sampleCtx.getImageData(x, y, 1, 1).data;
    // grass is bright green; asphalt is dark gray
    const bri = (d[0] + d[1] + d[2]) / 3;
    const greenish = d[1] > d[0] + 15 && d[1] > d[2] + 10 && bri > 120;
    if (greenish) return false;
    // accept dark asphalt / curb / finish (checkered has black+white — sample nearby)
    return bri < 175 || (Math.abs(d[0] - d[1]) < 25 && bri < 210);
  }

  // ---- Update ----
  function update(dt) {
    if (state.messageT > 0) state.messageT -= dt;
    if (state.shake > 0) state.shake -= dt;

    if (state.phase === "countdown") {
      state.countdown -= dt;
      if (state.countdown <= 0) {
        state.phase = "race";
        state.speed = 210;
        beep(880, 0.15, "square", 0.1);
      }
      return;
    }

    if (state.phase !== "race") return;

    state.time += dt;

    const steer = (wantLeft() ? -1 : 0) + (wantRight() ? 1 : 0);
    const turnRate = 2.8 + state.speed * 0.002;
    state.angle += steer * turnRate * dt;

    // accelerate / soft cap
    const target = 230 + Math.min(80, state.time * 3);
    state.speed += (target - state.speed) * Math.min(1, 2 * dt);

    // drift: velocity blends toward heading
    const hx = Math.cos(state.angle);
    const hy = Math.sin(state.angle);
    if (!state._vx) {
      state._vx = hx * state.speed;
      state._vy = hy * state.speed;
    }
    const grip = steer !== 0 ? 3.2 : 6.5;
    state._vx += (hx * state.speed - state._vx) * Math.min(1, grip * dt);
    state._vy += (hy * state.speed - state._vy) * Math.min(1, grip * dt);

    state.x += state._vx * dt;
    state.y += state._vy * dt;

    // trail when drifting
    const slip = Math.hypot(state._vx - hx * state.speed, state._vy - hy * state.speed);
    if (slip > 40 && Math.random() < dt * 40) {
      state.trails.push({ x: state.x, y: state.y, life: 0.7 });
    }
    for (const t of state.trails) t.life -= dt;
    state.trails = state.trails.filter((t) => t.life > 0).slice(-80);

    // progress
    const idx = nearestPathIndex(state.x, state.y);
    const prev = state.lapProgress;
    const cur = progressOf(idx);
    const n = PATH.length - 1;
    // detect wrap across finish
    let delta = cur - prev;
    if (delta < -n * 0.5) delta += n;
    if (delta > n * 0.5) delta -= n;
    state.lapProgress = cur;
    state.pathIdx = idx;

    // Finish: must travel most of the loop, then cross finish index forward
    const fi = meta.finishIndex || 0;
    const traveled = state._traveled || 0;
    state._traveled = traveled + Math.max(0, delta);
    const nearFinish = Math.min(Math.abs(cur - fi), n - Math.abs(cur - fi)) < 6;
    if (
      !state.crossedFinish &&
      nearFinish &&
      delta > 0 &&
      state.time > 4 &&
      state._traveled > n * 0.75
    ) {
      state.crossedFinish = true;
      onFinish();
      return;
    }

    // off-track: sample a few points under the cat
    const on =
      isOnTrack(state.x, state.y) &&
      isOnTrack(state.x + hx * 10, state.y + hy * 10) &&
      isOnTrack(state.x - hy * 8, state.y + hx * 8) &&
      isOnTrack(state.x + hy * 8, state.y - hx * 8);

    if (!on) {
      state.offRoadT += dt;
      if (state.offRoadT > 0.12) onCrash();
    } else {
      state.offRoadT = Math.max(0, state.offRoadT - dt * 2);
    }
  }

  // ---- Render ----
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    VW = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
    VH = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
    canvas.style.width = VW + "px";
    canvas.style.height = VH + "px";
    canvas.width = Math.round(VW * dpr);
    canvas.height = Math.round(VH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function camScale() {
    // show a local window of the world — not the whole loop
    const base = Math.min(VW / 280, VH / 420);
    return base * 1.15;
  }

  function draw() {
    // sky/grass fill
    ctx.fillStyle = "#b8e0c8";
    ctx.fillRect(0, 0, VW, VH);

    if (!ready) {
      ctx.fillStyle = "#ff6eb4";
      ctx.font = "bold 20px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading…", VW / 2, VH / 2);
      return;
    }

    const scale = camScale();
    let shakeX = 0;
    let shakeY = 0;
    if (state.shake > 0) {
      shakeX = (Math.random() - 0.5) * 10;
      shakeY = (Math.random() - 0.5) * 10;
    }

    const camX = state.x;
    const camY = state.y;

    ctx.save();
    ctx.translate(VW / 2 + shakeX, VH / 2 + shakeY);
    ctx.scale(scale, scale);
    ctx.translate(-camX, -camY);

    // track world
    if (img.track) {
      ctx.drawImage(img.track, 0, 0, WORLD_W, WORLD_H);
    }

    // drift trails
    for (const t of state.trails) {
      ctx.globalAlpha = Math.max(0, t.life) * 0.55;
      ctx.fillStyle = "#ff8fb8";
      ctx.beginPath();
      ctx.ellipse(t.x, t.y, 5, 3.5, state.angle, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // cat
    drawCat();

    ctx.restore();

    drawUI();
  }

  function drawCat() {
    const im = img.cat;
    const w = 46;
    const h = im ? (im.height / im.width) * w : 70;
    ctx.save();
    ctx.translate(state.x, state.y);
    // sprite faces up (-Y); angle 0 = +X, so rotate angle + PI/2
    ctx.rotate(state.angle + Math.PI / 2);
    // soft shadow
    ctx.fillStyle = "rgba(40,60,40,0.22)";
    ctx.beginPath();
    ctx.ellipse(0, 6, 16, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    if (im) ctx.drawImage(im, -w / 2, -h / 2, w, h);
    else {
      ctx.fillStyle = "#f4a261";
      ctx.beginPath();
      ctx.ellipse(0, 0, 16, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function fmtTime(t) {
    const s = Math.floor(t);
    const cs = Math.floor((t - s) * 100);
    return String(s).padStart(2, "0") + ":" + String(cs).padStart(2, "0");
  }

  function drawUI() {
    // timer
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui,Segoe UI,sans-serif";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.fillStyle = "#2d3436";
    const tstr = state.phase === "title" ? "MEOW DRIFT" : fmtTime(state.time);
    ctx.strokeText(tstr, VW / 2, 48 + (window.safeTop || 0));
    ctx.fillText(tstr, VW / 2, 48 + (window.safeTop || 0));

    if (state.best && state.phase !== "title") {
      ctx.font = "14px system-ui,sans-serif";
      ctx.fillStyle = "#5b8a7a";
      ctx.fillText("BEST " + fmtTime(state.best), VW / 2, 72 + (window.safeTop || 0));
    }

    // countdown
    if (state.phase === "countdown") {
      const n = Math.ceil(state.countdown);
      const label = n >= 3 ? "READY" : n === 2 ? "SET" : "GO!";
      ctx.font = "bold 64px system-ui,sans-serif";
      ctx.fillStyle = "#ff6eb4";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 8;
      ctx.strokeText(label, VW / 2, VH * 0.4);
      ctx.fillText(label, VW / 2, VH * 0.4);
    }

    if (state.phase === "title") {
      ctx.font = "16px system-ui,sans-serif";
      ctx.fillStyle = "#4a7064";
      ctx.fillText("闭环赛道 · 左右漂移冲线", VW / 2, VH * 0.42);
      ctx.font = "bold 18px system-ui,sans-serif";
      ctx.fillStyle = "#ff6eb4";
      ctx.fillText("点屏幕开始", VW / 2, VH * 0.48);
      ctx.font = "13px system-ui,sans-serif";
      ctx.fillStyle = "#5b8a7a";
      ctx.fillText("按住左右猫爪转向 · 别冲出跑道", VW / 2, VH * 0.54);
    }

    if ((state.phase === "crash" || state.phase === "done") && state.message) {
      ctx.font = "bold 22px system-ui,sans-serif";
      ctx.fillStyle = state.phase === "done" ? "#e8a317" : "#ff6eb4";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 6;
      ctx.strokeText(state.message, VW / 2, VH * 0.4);
      ctx.fillText(state.message, VW / 2, VH * 0.4);
      if (state.phase === "done") {
        ctx.font = "18px system-ui,sans-serif";
        ctx.fillStyle = "#2d3436";
        ctx.fillText(fmtTime(state.time), VW / 2, VH * 0.4 + 36);
        if (img.trophy) ctx.drawImage(img.trophy, VW / 2 - 36, VH * 0.4 + 50, 72, 66);
      }
      ctx.font = "14px system-ui,sans-serif";
      ctx.fillStyle = "#5b8a7a";
      ctx.fillText("点屏幕再来一局", VW / 2, VH * 0.72);
    }

    // paw buttons
    const pawY = VH - 70 - (window.safeBottom || 0);
    const pulse = 1 + Math.sin(performance.now() / 220) * 0.03;
    const s = 76 * pulse;
    drawPaw("paw_l", 56, pawY, s, wantLeft() ? 1 : 0.78);
    drawPaw("paw_r", VW - 56, pawY, s, wantRight() ? 1 : 0.78);
  }

  function drawPaw(key, x, y, size, alpha) {
    const im = img[key];
    ctx.globalAlpha = alpha;
    if (im) ctx.drawImage(im, x - size / 2, y - size / 2, size, size);
    else {
      ctx.fillStyle = "#ffb4d9";
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Boot ----
  function loadAssets() {
    const pack = window.ASSETS || {};
    const keys = Object.keys(pack);
    return Promise.all(
      keys.map(
        (k) =>
          new Promise((res) => {
            const im = new Image();
            im.onload = () => {
              img[k] = im;
              res();
            };
            im.onerror = () => res();
            im.src = pack[k];
          })
      )
    ).then(() => {
      if (img.track) {
        sampleCanvas.width = WORLD_W;
        sampleCanvas.height = WORLD_H;
        sampleCtx.drawImage(img.track, 0, 0, WORLD_W, WORLD_H);
        sampleReady = true;
      }
      if (PATH.length) resetCar();
      ready = true;
    });
  }

  let last = performance.now();
  function loop(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.033) dt = 0.033;
    if (ready) update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // expose for tests
  window.__MEOW__ = {
    get state() {
      return state;
    },
    startRace,
    resize,
  };

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 80));
  bindInput();
  loadAssets();
  requestAnimationFrame(loop);
})();
