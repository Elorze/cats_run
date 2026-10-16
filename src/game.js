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
  const TRACK_HALF = 50;

  // ---- Audio (procedural Web Audio — no external files) ----
  // Default MUTED. Sound starts only after the user taps the speaker button.
  let actx = null;
  let master = null;
  let musicBus = null;
  let sfxBus = null;
  let soundOn = localStorage.getItem("meowdrift_sound") === "1";
  let bgmPlaying = false;
  let bgmStepIndex = 0;
  let bgmNextT = 0;
  let engineOsc = null;
  let engineFilter = null;
  let engineGain = null;
  let roadNoise = null;
  let roadGain = null;
  let audioReady = false;

  function ensureAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return Promise.resolve(false);
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.0001;
      master.connect(actx.destination);
      musicBus = actx.createGain();
      musicBus.gain.value = 0.85;
      musicBus.connect(master);
      sfxBus = actx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);
      setupEngineNodes();
    }
    const resume =
      actx.state === "suspended" ? actx.resume().catch(() => {}) : Promise.resolve();
    return resume.then(() => {
      audioReady = actx.state === "running" || actx.state === "suspended";
      applyMute(true);
      return true;
    });
  }

  function applyMute(instant) {
    if (!actx || !master) return;
    const t = actx.currentTime;
    const vol = soundOn ? 0.55 : 0.0001;
    master.gain.cancelScheduledValues(t);
    if (instant) master.gain.setValueAtTime(vol, t);
    else master.gain.setTargetAtTime(vol, t, 0.04);
    if (soundOn) startBgm(true);
    else stopBgm();
  }

  function toggleSound() {
    soundOn = !soundOn;
    localStorage.setItem("meowdrift_sound", soundOn ? "1" : "0");
    ensureAudio().then(() => {
      applyMute(true);
      if (soundOn) {
        startBgm(true);
        // audible click so user knows sound unlocked
        beep(784, 0.1, "sine", 0.22);
        setTimeout(() => beep(988, 0.12, "triangle", 0.18), 90);
      } else {
        updateDriveAudio(false, 0);
      }
    });
  }

  function beep(freq, dur, type, vol) {
    if (!actx || !sfxBus || !soundOn) return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    const peak = vol || 0.2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.04, dur));
    o.connect(g);
    g.connect(sfxBus);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  function noiseBuffer(seconds) {
    const n = Math.max(1, (actx.sampleRate * seconds) | 0);
    const buf = actx.createBuffer(1, n, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function sfxHit() {
    if (!actx || !sfxBus || !soundOn) return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g);
    g.connect(sfxBus);
    o.start(t);
    o.stop(t + 0.22);

    const src = actx.createBufferSource();
    src.buffer = noiseBuffer(0.18);
    const f = actx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1200;
    const ng = actx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.28, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    src.connect(f);
    f.connect(ng);
    ng.connect(sfxBus);
    src.start(t);
    src.stop(t + 0.18);
  }

  function sfxFinish() {
    if (!soundOn) return;
    beep(523, 0.12, "sine", 0.22);
    setTimeout(() => beep(659, 0.12, "sine", 0.22), 90);
    setTimeout(() => beep(784, 0.2, "triangle", 0.24), 180);
  }

  // Looping chiptune BGM — keeps scheduling while soundOn
  const BGM_NOTES = [
    523.25, 659.25, 783.99, 1046.5, 783.99, 659.25, 587.33, 659.25,
    392.0, 523.25, 659.25, 783.99, 659.25, 523.25, 440.0, 523.25,
  ];
  const BGM_STEP = 0.2;

  function startBgm(forceRestart) {
    if (!actx || !musicBus || !soundOn) return;
    if (forceRestart || !bgmPlaying) {
      bgmPlaying = true;
      bgmStepIndex = 0;
      bgmNextT = actx.currentTime + 0.04;
    } else {
      bgmPlaying = true;
    }
  }

  function stopBgm() {
    bgmPlaying = false;
  }

  function pumpBgm() {
    if (!actx || !musicBus || !bgmPlaying || !soundOn) return;
    if (actx.state !== "running") return;
    const now = actx.currentTime;
    // avoid scheduling storms after tab sleep
    if (bgmNextT < now - 0.05) bgmNextT = now + 0.01;
    let guard = 0;
    while (bgmNextT < now + 0.9 && guard++ < 24) {
      const freq = BGM_NOTES[bgmStepIndex % BGM_NOTES.length];
      const t0 = bgmNextT;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = bgmStepIndex % 8 < 4 ? "triangle" : "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + BGM_STEP * 0.85);
      o.connect(g);
      g.connect(musicBus);
      o.start(t0);
      o.stop(t0 + BGM_STEP);

      if (bgmStepIndex % 4 === 0) {
        const b = actx.createOscillator();
        const bg = actx.createGain();
        b.type = "sine";
        b.frequency.value = freq / 2;
        bg.gain.setValueAtTime(0.0001, t0);
        bg.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
        bg.gain.exponentialRampToValueAtTime(0.0001, t0 + BGM_STEP * 1.5);
        b.connect(bg);
        bg.connect(musicBus);
        b.start(t0);
        b.stop(t0 + BGM_STEP * 1.6);
      }
      bgmStepIndex++;
      bgmNextT += BGM_STEP;
    }
  }

  function setupEngineNodes() {
    engineOsc = actx.createOscillator();
    engineOsc.type = "sawtooth";
    engineOsc.frequency.value = 70;
    engineFilter = actx.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 420;
    engineFilter.Q.value = 0.8;
    engineGain = actx.createGain();
    engineGain.gain.value = 0.0001;
    engineOsc.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(sfxBus);
    engineOsc.start();

    roadNoise = actx.createBufferSource();
    roadNoise.buffer = noiseBuffer(1.2);
    roadNoise.loop = true;
    const nf = actx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = 700;
    nf.Q.value = 0.6;
    roadGain = actx.createGain();
    roadGain.gain.value = 0.0001;
    roadNoise.connect(nf);
    nf.connect(roadGain);
    roadGain.connect(sfxBus);
    roadNoise.start();
  }

  function updateDriveAudio(onRoad, speed) {
    if (!actx || !engineGain || !roadGain) return;
    const t = actx.currentTime;
    const racing = state.phase === "race";
    const want = racing && soundOn;
    const spd = Math.max(0, speed);
    const targetEng = want ? (onRoad ? 0.08 + spd * 0.0002 : 0.035) : 0.0001;
    const targetRoad = want && onRoad ? 0.04 + spd * 0.00008 : want ? 0.02 : 0.0001;
    engineGain.gain.setTargetAtTime(targetEng, t, 0.08);
    roadGain.gain.setTargetAtTime(targetRoad, t, 0.1);
    if (engineOsc) engineOsc.frequency.setTargetAtTime(55 + spd * 0.55, t, 0.08);
    if (engineFilter) {
      engineFilter.frequency.setTargetAtTime(onRoad ? 380 + spd * 1.2 : 220, t, 0.1);
    }
  }

  function muteBtn() {
    return { x: VW - 36, y: 36, r: 20 };
  }

  function hitMute(clientX, clientY) {
    const x = (clientX / Math.max(1, window.innerWidth)) * VW;
    const y = (clientY / Math.max(1, window.innerHeight)) * VH;
    const b = muteBtn();
    return Math.hypot(x - b.x, y - b.y) <= b.r + 10;
  }

  function drawMuteButton() {
    const b = muteBtn();
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.fillStyle = "rgba(59,36,28,0.82)";
    ctx.beginPath();
    ctx.arc(0, 0, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff6e8";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // speaker body
    ctx.fillStyle = "#fff6e8";
    ctx.beginPath();
    ctx.moveTo(-8, -5);
    ctx.lineTo(-2, -5);
    ctx.lineTo(5, -11);
    ctx.lineTo(5, 11);
    ctx.lineTo(-2, 5);
    ctx.lineTo(-8, 5);
    ctx.closePath();
    ctx.fill();

    if (soundOn) {
      ctx.strokeStyle = "#ffe066";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(6, 0, 5, -0.7, 0.7);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(6, 0, 9, -0.7, 0.7);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#ff8fbf";
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(-10, -10);
      ctx.lineTo(10, 10);
      ctx.stroke();
    }
    ctx.restore();
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
        if (e.key === "m" || e.key === "M") toggleSound();
        e.preventDefault();
      },
      { passive: false }
    );
    window.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "a", "A"].includes(e.key)) keys.delete("L");
      if (["ArrowRight", "d", "D"].includes(e.key)) keys.delete("R");
    });

    const onDown = (e) => {
      // Mute button: unlock AudioContext + toggle. Does NOT start the race.
      if (hitMute(e.clientX, e.clientY)) {
        toggleSound();
        e.preventDefault();
        return;
      }
      // Other taps may unlock audio if already enabled, but never auto-unmute.
      if (soundOn) ensureAudio();
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
    const n = Math.max(1, PATH.length - 1);
    return ((idx % n) + n) % n;
  }

  function segDist(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const ab2 = abx * abx + aby * aby || 1;
    let t = ((px - ax) * abx + (py - ay) * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
  }

  function distToPath(x, y) {
    let best = 1e9;
    const n = PATH.length - 1;
    for (let i = 0; i < n; i++) {
      const a = PATH[i];
      const b = PATH[i + 1];
      const d = segDist(x, y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
    return best;
  }

  function buildProps() {
    const obstacles = [];
    const scenery = [];
    const n = PATH.length - 1;
    if (n < 8) return { obstacles, scenery };
    const kinds = ["tire", "yarn", "bush"];
    for (let i = 6; i < n; i += 13) {
      const p = PATH[i];
      const t = pathTangent(i);
      const nx = -t.y;
      const ny = t.x;
      const t2 = pathTangent((i + 4) % n);
      const cross = t.x * t2.y - t.y * t2.x;
      const side = cross >= 0 ? 1 : -1;
      const kind = kinds[((i / 13) | 0) % kinds.length];
      obstacles.push({
        x: p.x + nx * side * TRACK_HALF * 0.62,
        y: p.y + ny * side * TRACK_HALF * 0.62,
        r: kind === "tire" ? 20 : 16,
        kind,
        cool: 0,
      });
      scenery.push({
        x: p.x - nx * side * (TRACK_HALF + 34),
        y: p.y - ny * side * (TRACK_HALF + 34),
        kind: i % 2 === 0 ? "bush" : "paw",
      });
    }
    return { obstacles, scenery };
  }

  const props = buildProps();

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
    slowT: 0,
    message: "",
    messageT: 0,
    offRoadT: 0,
  };

  function resetCar() {
    const si = meta.startIndex || 0;
    const p = PATH[si] || PATH[0] || { x: 400, y: 600 };
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
    state.slowT = 0;
    state._vx = 0;
    state._vy = 0;
    state._traveled = 0;
    state._finishSide = null;
  }

  function startRace() {
    if (soundOn) {
      ensureAudio().then(() => {
        startBgm(false);
        beep(440, 0.08, "triangle", 0.12);
      });
    }
    resetCar();
    state.phase = "countdown";
    state.countdown = 3.2;
    state.message = "";
  }

  function onFinish() {
    state.phase = "done";
    state.speed = 0;
    state._vx = 0;
    state._vy = 0;
    state.message = "冲线！";
    state.messageT = 3.5;
    if (!state.best || state.time < state.best) {
      state.best = state.time;
      localStorage.setItem("meowdrift_best", String(state.best));
    }
    updateDriveAudio(false, 0);
    sfxFinish();
  }

  // ---- Update ----
  function update(dt) {
    if (state.messageT > 0) state.messageT -= dt;
    if (state.shake > 0) state.shake -= dt;
    if (state.phase === "countdown") {
      const prevStage = state.countdown > 2.1 ? 0 : state.countdown > 1.05 ? 1 : 2;
      state.countdown -= dt;
      updateDriveAudio(true, 0);
      if (state.countdown <= 0) {
        state.phase = "race";
        state.speed = 210;
        beep(880, 0.15, "square", 0.12);
        return;
      }
      const stage = state.countdown > 2.1 ? 0 : state.countdown > 1.05 ? 1 : 2;
      if (stage !== prevStage) {
        beep(stage === 2 ? 660 : 440, 0.09, "triangle", 0.11);
      }
      return;
    }

    if (state.phase !== "race") {
      updateDriveAudio(false, 0);
      return;
    }

    state.time += dt;

    const steer = (wantLeft() ? -1 : 0) + (wantRight() ? 1 : 0);
    const turnRate = 2.8 + state.speed * 0.002;
    state.angle += steer * turnRate * dt;

    // Hits and grass hold the speed cap down so the slowdown is felt.
    let target = 230 + Math.min(80, state.time * 3);
    if (state.slowT > 0) {
      state.slowT -= dt;
      target = 95;
    }
    const onRoad = distToPath(state.x, state.y) <= TRACK_HALF * 0.92;
    if (!onRoad) {
      target = Math.min(target, 70);
    }
    state.speed += (target - state.speed) * Math.min(1, 2.2 * dt);
    updateDriveAudio(onRoad, state.speed);

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

    // progress along centerline
    const idx = nearestPathIndex(state.x, state.y);
    const prev = state.lapProgress;
    const cur = progressOf(idx);
    const n = PATH.length - 1;
    let delta = cur - prev;
    if (delta < -n * 0.5) delta += n;
    if (delta > n * 0.5) delta -= n;
    state.lapProgress = cur;
    state.pathIdx = idx;
    state._traveled = (state._traveled || 0) + Math.max(0, delta);

    // Finish: progress wraps across finishIndex after most of a lap.
    // (Half-plane tests flip elsewhere on the loop and miss the real line.)
    const fi = meta.finishIndex || 0;
    const prevRel = ((prev - fi) % n + n) % n;
    const curRel = ((cur - fi) % n + n) % n;
    const wrappedAcrossFinish = prevRel > n - 14 && curRel < 14;
    const nearStrip = distToPath(state.x, state.y) < TRACK_HALF * 1.25;
    if (
      !state.crossedFinish &&
      state.time > 3.2 &&
      state._traveled > n * 0.65 &&
      nearStrip &&
      wrappedAcrossFinish
    ) {
      state.crossedFinish = true;
      onFinish();
      return;
    }

    for (const o of props.obstacles) {
      if (o.cool > 0) o.cool -= dt;
      const d = Math.hypot(state.x - o.x, state.y - o.y);
      if (d < o.r + 18 && o.cool <= 0) {
        o.cool = 0.7;
        state.slowT = 0.85;
        state.speed *= 0.35;
        state._vx *= 0.35;
        state._vy *= 0.35;
        state.shake = 0.16;
        sfxHit();
      }
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
    // Phone-like local window (~340×520 world units), capped so desktop
    // windows don't zoom the cat into a giant portrait with no road.
    const base = Math.min(VW / 340, VH / 520);
    return Math.min(1.85, Math.max(0.85, base));
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

    if (state.phase === "title") {
      drawTitle();
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

    drawWorld();

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

  function tracePath() {
    if (!PATH.length) return;
    ctx.beginPath();
    ctx.moveTo(PATH[0].x, PATH[0].y);
    for (let i = 1; i < PATH.length; i++) ctx.lineTo(PATH[i].x, PATH[i].y);
    ctx.closePath();
  }

  function drawWorld() {
    ctx.fillStyle = "#b7e6c9";
    ctx.fillRect(state.x - 2500, state.y - 2500, 5000, 5000);

    if (PATH.length < 2) return;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    tracePath();
    ctx.strokeStyle = "#2a2d32";
    ctx.lineWidth = TRACK_HALF * 2 + 16;
    ctx.stroke();
    ctx.strokeStyle = "#5c616a";
    ctx.lineWidth = TRACK_HALF * 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 3;
    ctx.stroke();

    drawCurbs();
    drawFinish();
    for (const s of props.scenery) drawScenery(s);
    for (const o of props.obstacles) drawObstacle(o);
  }

  function drawCurbs() {
    // Clean outer rumble strips only on stronger bends — no scattered blocks.
    const n = PATH.length - 1;
    if (n < 8) return;
    for (let i = 0; i < n; i += 3) {
      const t = pathTangent(i);
      const t2 = pathTangent((i + 5) % n);
      const cross = t.x * t2.y - t.y * t2.x;
      if (Math.abs(cross) < 0.22) continue;
      const p = PATH[i];
      const side = cross > 0 ? 1 : -1;
      const nx = -t.y * side;
      const ny = t.x * side;
      const ang = Math.atan2(t.y, t.x);
      ctx.save();
      ctx.translate(p.x + nx * (TRACK_HALF - 1), p.y + ny * (TRACK_HALF - 1));
      ctx.rotate(ang);
      for (let k = 0; k < 4; k++) {
        ctx.fillStyle = k % 2 ? "#e23b3b" : "#f7f7f7";
        ctx.fillRect(-10 + k * 6, -4.5, 6, 9);
      }
      ctx.restore();
    }
  }

  function drawFinish() {
    const n = PATH.length - 1;
    if (!n) return;
    const i = meta.finishIndex || 0;
    const p = PATH[i];
    const t = pathTangent(i);
    const ang = Math.atan2(t.y, t.x);
    const nx = -t.y;
    const ny = t.x;

    // Side barriers (red/white), like the reference — not a spray of curb crumbs.
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(p.x + nx * side * (TRACK_HALF + 10), p.y + ny * side * (TRACK_HALF + 10));
      ctx.rotate(ang);
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k % 2 ? "#e23b3b" : "#fff";
        ctx.fillRect(-14 + k * 7, -7, 7, 14);
      }
      ctx.restore();
    }

    // One clean black/white checkered strip across the asphalt.
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang + Math.PI / 2);
    const cells = 8;
    const cw = (TRACK_HALF * 2) / cells;
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < cells; k++) {
        ctx.fillStyle = (k + row) % 2 ? "#111" : "#f5f5f5";
        ctx.fillRect(-TRACK_HALF + k * cw, -8 + row * 8, cw + 0.4, 8.2);
      }
    }
    ctx.restore();
  }

  function drawObstacle(o) {
    if (o.kind === "tire") {
      ctx.fillStyle = "#1c1c1c";
      ctx.beginPath();
      ctx.arc(o.x - 6, o.y, 11, 0, Math.PI * 2);
      ctx.arc(o.x + 7, o.y + 2, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3a3a3a";
      ctx.beginPath();
      ctx.arc(o.x - 6, o.y, 5, 0, Math.PI * 2);
      ctx.arc(o.x + 7, o.y + 2, 5, 0, Math.PI * 2);
      ctx.fill();
    } else if (o.kind === "yarn") {
      const colors = ["#ff8fb8", "#7ec8ff", "#ffe066"];
      ctx.fillStyle = colors[(o.x | 0) % 3];
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(80,40,40,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x, o.y, o.r * 0.55, 0.2, 2.4);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#3e9a55";
      ctx.beginPath();
      ctx.arc(o.x, o.y - 4, 12, 0, Math.PI * 2);
      ctx.arc(o.x - 10, o.y + 4, 10, 0, Math.PI * 2);
      ctx.arc(o.x + 10, o.y + 4, 10, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawScenery(s) {
    if (s.kind === "bush") {
      ctx.fillStyle = "#2f8a49";
      ctx.beginPath();
      ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
      ctx.arc(s.x - 12, s.y + 6, 11, 0, Math.PI * 2);
      ctx.arc(s.x + 12, s.y + 6, 11, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255,143,184,0.85)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 4, 7, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 3; k++) {
        const a = -0.8 + k * 0.8;
        ctx.beginPath();
        ctx.arc(s.x + Math.cos(a) * 7, s.y - 4 + Math.sin(a) * 4, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawVectorCat(scale) {
    const s = scale || 1;
    // Soft shadow
    ctx.fillStyle = "rgba(40,60,40,0.22)";
    ctx.beginPath();
    ctx.ellipse(0, 7 * s, 15 * s, 7 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    const stroke = "#5a3418";
    const fur = "#f0a14a";
    const furDark = "#d97d2e";
    const belly = "#ffe0b0";

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Tail
    ctx.strokeStyle = stroke;
    ctx.fillStyle = fur;
    ctx.lineWidth = 2.2 * s;
    ctx.beginPath();
    ctx.moveTo(0, 16 * s);
    ctx.quadraticCurveTo(14 * s, 28 * s, 6 * s, 40 * s);
    ctx.quadraticCurveTo(-2 * s, 34 * s, -2 * s, 18 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = furDark;
    ctx.lineWidth = 2 * s;
    for (let i = 0; i < 3; i++) {
      const ty = 22 * s + i * 6 * s;
      ctx.beginPath();
      ctx.moveTo(2 * s, ty);
      ctx.lineTo(8 * s, ty + 3 * s);
      ctx.stroke();
    }

    // Body
    ctx.fillStyle = fur;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.4 * s;
    ctx.beginPath();
    ctx.ellipse(0, 4 * s, 16 * s, 20 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Belly patch
    ctx.fillStyle = belly;
    ctx.beginPath();
    ctx.ellipse(0, 8 * s, 8 * s, 11 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // Back stripes
    ctx.strokeStyle = furDark;
    ctx.lineWidth = 2.6 * s;
    for (let i = 0; i < 3; i++) {
      const yy = -2 * s + i * 7 * s;
      ctx.beginPath();
      ctx.moveTo(-10 * s, yy);
      ctx.quadraticCurveTo(0, yy - 2 * s, 10 * s, yy);
      ctx.stroke();
    }

    // Head
    ctx.fillStyle = fur;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.4 * s;
    ctx.beginPath();
    ctx.ellipse(0, -18 * s, 13 * s, 12 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Ears
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 6 * s, -26 * s);
      ctx.lineTo(side * 12 * s, -36 * s);
      ctx.lineTo(side * 2 * s, -28 * s);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffb6c8";
      ctx.beginPath();
      ctx.moveTo(side * 6.5 * s, -27 * s);
      ctx.lineTo(side * 10 * s, -33 * s);
      ctx.lineTo(side * 4 * s, -28 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = fur;
    }

    // Closed eyes + nose (top-down cute face peeking forward)
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.8 * s;
    ctx.beginPath();
    ctx.arc(-4.5 * s, -20 * s, 2.2 * s, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(4.5 * s, -20 * s, 2.2 * s, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.fillStyle = "#ff8fab";
    ctx.beginPath();
    ctx.moveTo(0, -16.5 * s);
    ctx.lineTo(-2.2 * s, -14.5 * s);
    ctx.lineTo(2.2 * s, -14.5 * s);
    ctx.closePath();
    ctx.fill();
  }

  function drawCat() {
    ctx.save();
    ctx.translate(state.x, state.y);
    // Facing up in local space; world angle 0 = +X
    ctx.rotate(state.angle + Math.PI / 2);
    drawVectorCat(1);
    ctx.restore();
  }

  function fmtTime(t) {
    const s = Math.floor(t);
    const cs = Math.floor((t - s) * 100);
    return String(s).padStart(2, "0") + ":" + String(cs).padStart(2, "0");
  }

  function titlePoint(t) {
    const p0 = { x: -VW * 0.08, y: VH * 0.58 };
    const p1 = { x: VW * 0.42, y: VH * 0.46 };
    const p2 = { x: VW * 1.08, y: VH * 0.55 };
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    };
  }

  function titleTangent(t) {
    const a = titlePoint(Math.max(0, t - 0.012));
    const b = titlePoint(Math.min(1, t + 0.012));
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  function drawGrassTuft(x, y, s) {
    ctx.fillStyle = "#7dca8e";
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.ellipse(x + i * 3.2 * s, y, 2.2 * s, 7 * s, i * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBush(x, y, s) {
    ctx.fillStyle = "#2f9a52";
    ctx.beginPath();
    ctx.arc(x, y - 6 * s, 16 * s, 0, Math.PI * 2);
    ctx.arc(x - 14 * s, y + 4 * s, 13 * s, 0, Math.PI * 2);
    ctx.arc(x + 14 * s, y + 4 * s, 13 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3eb86a";
    ctx.beginPath();
    ctx.arc(x - 2 * s, y - 8 * s, 8 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawYarnBall(x, y, color, r) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(90,40,50,0.28)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0.4, 2.6);
    ctx.stroke();
  }

  function drawGear(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#f2c14e";
    ctx.strokeStyle = "#6a3d28";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * 16, Math.sin(a) * 16);
      ctx.lineTo(Math.cos(a + 0.22) * 11, Math.sin(a + 0.22) * 11);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff6d8";
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawTrophy(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#f2c14e";
    ctx.strokeStyle = "#6a3d28";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-12, -14);
    ctx.lineTo(12, -14);
    ctx.quadraticCurveTo(14, 6, 0, 12);
    ctx.quadraticCurveTo(-14, 6, -12, -14);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-14, -6, 6, Math.PI * 0.5, Math.PI * 1.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(14, -6, 6, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.stroke();
    ctx.fillRect(-8, 12, 16, 4);
    ctx.fillRect(-11, 16, 22, 5);
    ctx.strokeRect(-11, 16, 22, 5);
    ctx.restore();
  }

  function drawStartButton(x, y) {
    const pulse = 1 + Math.sin(performance.now() / 280) * 0.025;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = "#ff7eb5";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 10, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-34, -8);
    ctx.lineTo(-50, -48);
    ctx.lineTo(-10, -24);
    ctx.closePath();
    ctx.moveTo(34, -8);
    ctx.lineTo(50, -48);
    ctx.lineTo(10, -24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.beginPath();
    ctx.ellipse(-12, -8, 18, 10, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#8a3d62";
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.font = '900 22px "Arial Rounded MT Bold", "Trebuchet MS", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText("START", 0, 2);
    ctx.fillText("START", 0, 2);
    ctx.font = '900 11px "Arial Rounded MT Bold", "Trebuchet MS", sans-serif';
    ctx.fillStyle = "#ffe56a";
    ctx.lineWidth = 3;
    ctx.strokeText("TAP TO PLAY", 0, 22);
    ctx.fillText("TAP TO PLAY", 0, 22);
    ctx.restore();
  }

  function drawTitle() {
    ctx.fillStyle = "#d7f6e2";
    ctx.fillRect(0, 0, VW, VH);

    const tufts = [
      [0.12, 0.22],
      [0.84, 0.18],
      [0.08, 0.48],
      [0.9, 0.46],
      [0.18, 0.78],
      [0.78, 0.8],
      [0.5, 0.86],
      [0.3, 0.34],
      [0.7, 0.72],
    ];
    for (const [u, v] of tufts) drawGrassTuft(VW * u, VH * v, 1);
    drawBush(VW * 0.1, VH * 0.3, 1.15);
    drawBush(VW * 0.9, VH * 0.28, 1);
    drawBush(VW * 0.14, VH * 0.72, 0.9);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const p = titlePoint(i / 48);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = "#2a2d32";
    ctx.lineWidth = Math.min(118, VW * 0.3);
    ctx.stroke();
    ctx.strokeStyle = "#5c616a";
    ctx.lineWidth = Math.min(100, VW * 0.26);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 3;
    ctx.stroke();

    const half = Math.min(50, VW * 0.13);
    for (let i = 0; i < 16; i++) {
      const t = 0.06 + i * 0.052;
      const p = titlePoint(t);
      const ang = titleTangent(t);
      const nx = Math.cos(ang + Math.PI / 2);
      const ny = Math.sin(ang + Math.PI / 2);
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(p.x + nx * side * half, p.y + ny * side * half);
        ctx.rotate(ang);
        ctx.fillStyle = i % 2 ? "#ff8fb8" : "#fff";
        ctx.fillRect(-8, -6, 16, 12);
        ctx.restore();
      }
    }

    const ft = 0.78;
    const fp = titlePoint(ft);
    const fang = titleTangent(ft);
    ctx.save();
    ctx.translate(fp.x, fp.y);
    ctx.rotate(fang + Math.PI / 2);
    const cells = 8;
    const cw = (half * 2) / cells;
    for (let k = 0; k < cells; k++) {
      ctx.fillStyle = k % 2 ? "#111" : "#fff";
      ctx.fillRect(-half + k * cw, -8, cw + 0.6, 16);
    }
    ctx.restore();

    const yarns = [
      [0.22, 18, "#ff8fb8", 11],
      [0.58, -16, "#ffe066", 12],
      [0.9, 22, "#7ec8ff", 10],
    ];
    for (const [t, off, color, r] of yarns) {
      const p = titlePoint(t);
      const ang = titleTangent(t);
      drawYarnBall(
        p.x + Math.cos(ang + Math.PI / 2) * off,
        p.y + Math.sin(ang + Math.PI / 2) * off,
        color,
        r
      );
    }

    const ct = 0.48 + Math.sin(performance.now() / 700) * 0.02;
    for (let i = 1; i <= 7; i++) {
      const p = titlePoint(ct - i * 0.035);
      const ang = titleTangent(ct - i * 0.035);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.fillStyle = i % 2 ? "#ff8fb8" : "rgba(255,143,184,0.45)";
      ctx.beginPath();
      ctx.ellipse(-10, 0, 7, 3.2, 0, 0, Math.PI * 2);
      ctx.ellipse(10, 0, 7, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const catP = titlePoint(ct);
    const catA = titleTangent(ct);
    ctx.save();
    ctx.translate(catP.x, catP.y);
    ctx.rotate(catA + Math.PI / 2);
    drawVectorCat(1.15);
    ctx.restore();

    drawBrandLogo(VW / 2, 28);
    const subW = Math.min(VW * 0.86, 340);
    const subY = 132;
    ctx.fillStyle = "#6a3d28";
    ctx.beginPath();
    ctx.roundRect(VW / 2 - subW / 2 - 8, subY - 4, subW + 16, 44, 16);
    ctx.fill();
    ctx.fillStyle = "#fff6e8";
    ctx.font = '800 15px "Trebuchet MS", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("闭环赛道 · 左右漂移冲线", VW / 2, subY + 18);

    const btnY = VH * 0.73;
    drawStartButton(VW / 2, btnY);
    ctx.fillStyle = "#6a3d28";
    ctx.font = '800 14px "Trebuchet MS", sans-serif';
    ctx.fillText("按住猫爪左右漂移", VW / 2, btnY + 62);
    ctx.font = '700 13px "Trebuchet MS", sans-serif';
    ctx.fillStyle = soundOn ? "#2f9a52" : "#8a5a40";
    ctx.fillText(
      soundOn ? "声音已开 · 背景音乐播放中" : "点击右上角喇叭开启声音",
      VW / 2,
      btnY + 84
    );

    const pawY = VH - 58;
    drawPaw("paw_l", 52, pawY, 72, 1);
    drawPaw("paw_r", VW - 52, pawY, 72, 1);
    drawMuteButton();
  }

  function drawBrandLogo(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.font = `900 ${Math.min(54, VW * 0.13)}px "Trebuchet MS", "Arial Rounded MT Bold", sans-serif`;
    ctx.strokeStyle = "#5a3418";
    ctx.lineWidth = 10;
    ctx.strokeText("MEOW", 0, 0);
    const grad = ctx.createLinearGradient(0, 0, 0, 50);
    grad.addColorStop(0, "#ffb347");
    grad.addColorStop(1, "#ff6eb4");
    ctx.fillStyle = grad;
    ctx.fillText("MEOW", 0, 0);
    ctx.font = `900 ${Math.min(42, VW * 0.1)}px "Trebuchet MS", "Arial Rounded MT Bold", sans-serif`;
    ctx.strokeText("DRIFT", 0, 52);
    ctx.fillStyle = "#ffe066";
    ctx.fillText("DRIFT", 0, 52);
    ctx.restore();
  }

  function drawSprite(key, x, y, w) {
    const im = img[key];
    if (!im) return;
    const h = w * (im.height / im.width);
    ctx.drawImage(im, x - w / 2, y, w, h);
  }

  function drawTimer(x, y) {
    const label = fmtTime(state.time);
    ctx.font = 'bold 26px "Arial Rounded MT Bold", "Trebuchet MS", sans-serif';
    const w = 124;
    const h = 42;
    ctx.fillStyle = "#3b241c";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y, w, h, 21);
    ctx.fill();
    ctx.fillStyle = "#ffd0e6";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + h / 2 + 1);
    ctx.textBaseline = "alphabetic";
  }

  function drawStartLights(countdown) {
    // Traffic-light style READY / SET / GO — drawn in code, no cutout sprites.
    const stage = countdown > 2.1 ? 0 : countdown > 1.05 ? 1 : 2;
    const labels = ["READY", "SET", "GO!"];
    const colors = ["#e23b3b", "#f0c040", "#3ddc84"];
    const cx = VW / 2;
    const cy = VH * 0.32;
    const r = Math.min(22, VW * 0.055);

    // housings
    for (let i = 0; i < 3; i++) {
      const x = cx + (i - 1) * (r * 2.8);
      ctx.fillStyle = "#2a2d32";
      ctx.beginPath();
      ctx.roundRect(x - r - 6, cy - r - 6, (r + 6) * 2, (r + 6) * 2, 12);
      ctx.fill();
      ctx.fillStyle = i === stage ? colors[i] : "#4a4e55";
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (i === stage) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.ellipse(x - r * 0.25, cy - r * 0.3, r * 0.45, r * 0.28, -0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const pulse = 1 + Math.sin(performance.now() / 140) * 0.04;
    ctx.save();
    ctx.translate(cx, cy + r * 3.2);
    ctx.scale(pulse, pulse);
    ctx.font = `900 ${Math.min(64, VW * 0.16)}px "Trebuchet MS", "Arial Rounded MT Bold", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#3b241c";
    ctx.lineWidth = 8;
    ctx.fillStyle = colors[stage];
    ctx.strokeText(labels[stage], 0, 0);
    ctx.fillText(labels[stage], 0, 0);
    ctx.restore();
  }

  function drawFinishBanner() {
    const cx = VW / 2;
    const cy = VH * 0.36;
    ctx.fillStyle = "rgba(30, 24, 20, 0.55)";
    ctx.fillRect(0, 0, VW, VH);

    ctx.fillStyle = "#fff6e8";
    ctx.strokeStyle = "#6a3d28";
    ctx.lineWidth = 5;
    const bw = Math.min(VW * 0.86, 340);
    const bh = 150;
    ctx.beginPath();
    ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 22);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#6a3d28";
    ctx.font = '900 28px "Trebuchet MS", "Arial Rounded MT Bold", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("冲线成功！", cx, cy - 36);
    ctx.font = '900 40px "Trebuchet MS", "Arial Rounded MT Bold", sans-serif';
    ctx.fillStyle = "#ff6eb4";
    ctx.fillText(fmtTime(state.time), cx, cy + 8);
    ctx.font = '700 16px "Trebuchet MS", sans-serif';
    ctx.fillStyle = "#8a5a40";
    const best = state.best ? `最佳 ${fmtTime(state.best)}` : "新纪录！";
    ctx.fillText(best, cx, cy + 48);

    // Again hint
    const pulse = 1 + Math.sin(performance.now() / 260) * 0.03;
    ctx.save();
    ctx.translate(cx, VH * 0.62);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = "#ff7eb5";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(-90, -22, 180, 44, 22);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = '900 18px "Trebuchet MS", sans-serif';
    ctx.fillText("再来一局", 0, 2);
    ctx.restore();
  }

  function drawUI() {
    const top = 18;

    if (state.phase === "title") {
      const logoW = Math.min(VW * 0.78, 320);
      drawSprite("ui_meow", VW / 2, top, logoW);
      drawSprite("ui_drift", VW / 2, top + logoW * 0.62, Math.min(VW * 0.72, 300));
      drawSprite("ui_tap", VW / 2, VH * 0.4, Math.min(VW * 0.86, 340));
      drawSprite("ui_hints", VW / 2, VH * 0.47, Math.min(VW * 0.9, 360));
    } else {
      drawTimer(VW / 2, top);
    }

    if (state.phase === "countdown") {
      drawStartLights(state.countdown);
    }

    if (state.phase === "done") {
      drawFinishBanner();
    }

    // paw buttons
    const pawY = VH - 70 - (window.safeBottom || 0);
    const pulse = 1 + Math.sin(performance.now() / 220) * 0.03;
    const s = 76 * pulse;
    drawPaw("paw_l", 56, pawY, s, wantLeft() ? 1 : 0.78);
    drawPaw("paw_r", VW - 56, pawY, s, wantRight() ? 1 : 0.78);
    drawMuteButton();
  }

  function drawPaw(key, x, y, size, alpha) {
    const label = key === "paw_l" ? "L" : "R";
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    const s = size / 72;
    // soft ground shadow
    ctx.fillStyle = "rgba(40,60,40,0.16)";
    ctx.beginPath();
    ctx.ellipse(0, 6 * s, 28 * s, 12 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ff8fbf";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4 * s;
    // toe beans
    const toes = [
      [-18, -16],
      [-6, -22],
      [6, -22],
      [18, -16],
    ];
    for (const [tx, ty] of toes) {
      ctx.beginPath();
      ctx.ellipse(tx * s, ty * s, 9 * s, 11 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // pad
    ctx.beginPath();
    ctx.ellipse(0, 6 * s, 20 * s, 17 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#8a3d62";
    ctx.lineWidth = 3 * s;
    ctx.font = `900 ${22 * s}px "Trebuchet MS", "Arial Rounded MT Bold", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(label, 0, 7 * s);
    ctx.fillText(label, 0, 7 * s);
    ctx.restore();
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
      if (PATH.length) resetCar();
      ready = true;
    });
  }

  let last = performance.now();
  function loop(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.033) dt = 0.033;
    // Keep BGM scheduling every frame while unmuted (title/race/done).
    pumpBgm();
    if (ready) update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  // expose for tests
  window.__MEOW__ = {
    get state() {
      return state;
    },
    get soundOn() {
      return soundOn;
    },
    get audioDebug() {
      return {
        soundOn,
        bgmPlaying,
        bgmStepIndex,
        ctxState: actx ? actx.state : "none",
        masterGain: master ? master.gain.value : null,
        audioReady,
      };
    },
    toggleSound,
    ensureAudio,
    sfxHit,
    startRace,
    resize,
    props,
  };

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 80));
  bindInput();
  loadAssets();
  requestAnimationFrame(loop);
})();
