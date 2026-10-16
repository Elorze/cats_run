(() => {
  "use strict";

  const W = 390;
  const H = 694;
  const LANES = 3;
  const LAP_DIST = 2400;
  const MAX_LAPS = 3;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  /** @type {Record<string, HTMLImageElement>} */
  const img = {};
  let ready = false;
  let started = false;

  // ---- Audio (Web Audio API, no external files) ----
  let actx = null;
  let master = null;
  let purrTimer = 0;

  function ensureAudio() {
    if (actx) {
      if (actx.state === "suspended") actx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    master = actx.createGain();
    master.gain.value = 0.22;
    master.connect(actx.destination);
  }

  function tone(freq, dur, type, vol, slide) {
    if (!actx || !master) return;
    const t0 = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function sfxCollect() {
    ensureAudio();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      setTimeout(() => tone(f, 0.12, "triangle", 0.18), i * 45);
    });
  }
  function sfxNear() {
    ensureAudio();
    tone(880, 0.08, "square", 0.1, 1320);
    setTimeout(() => tone(1175, 0.1, "triangle", 0.12), 40);
  }
  function sfxHit() {
    ensureAudio();
    tone(180, 0.18, "sawtooth", 0.14, 70);
    setTimeout(() => tone(120, 0.22, "triangle", 0.12, 60), 60);
  }
  function sfxLap() {
    ensureAudio();
    [392, 494, 587, 784].forEach((f, i) => setTimeout(() => tone(f, 0.16, "sine", 0.16), i * 70));
  }
  function sfxPurr(dt) {
    if (!actx || !master || state.mode !== "play") return;
    purrTimer -= dt;
    if (purrTimer > 0) return;
    purrTimer = 0.16;
    tone(90 + Math.random() * 20, 0.08, "triangle", 0.035);
  }

  // ---- Input ----
  const keys = new Set();
  let holdLeft = false;
  let holdRight = false;

  function bindInput() {
    const down = (e) => {
      ensureAudio();
      const k = e.key;
      if (["ArrowLeft", "a", "A"].includes(k)) keys.add("L");
      if (["ArrowRight", "d", "D"].includes(k)) keys.add("R");
      if ((k === " " || k === "Enter") && state.mode === "title") beginPlay();
      e.preventDefault();
    };
    const up = (e) => {
      const k = e.key;
      if (["ArrowLeft", "a", "A"].includes(k)) keys.delete("L");
      if (["ArrowRight", "d", "D"].includes(k)) keys.delete("R");
    };
    window.addEventListener("keydown", down, { passive: false });
    window.addEventListener("keyup", up);

    const pointer = (clientX, clientY, isDown) => {
      ensureAudio();
      const rect = canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * W;
      const y = ((clientY - rect.top) / rect.height) * H;
      if (state.mode === "title") {
        if (isDown) beginPlay();
        return;
      }
      if (isDown) {
        holdLeft = x < W * 0.5;
        holdRight = x >= W * 0.5;
      }
    };

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointer(e.clientX, e.clientY, true);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener("pointerup", () => {
      holdLeft = holdRight = false;
    });
    canvas.addEventListener("pointercancel", () => {
      holdLeft = holdRight = false;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons || e.pressure > 0) pointer(e.clientX, e.clientY, true);
    }, { passive: false });

    // prevent page scroll / pull-to-refresh
    document.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  // ---- Game state ----
  const state = {
    mode: "title", // title | play
    score: 0,
    lap: 1,
    dist: 0,
    speed: 280,
    lane: 1,
    catX: W * 0.5,
    catY: H * 0.68,
    hitT: 0,
    shakeT: 0,
    shakeMag: 0,
    bob: 0,
    entities: [],
    particles: [],
    floaters: [],
    spawnAcc: 0,
    invuln: 0,
    combo: 1,
    finishFlash: 0,
    titlePulse: 0,
  };

  function laneX(i) {
    const left = W * 0.22;
    const right = W * 0.78;
    return left + ((right - left) * i) / (LANES - 1);
  }

  function resetRun() {
    state.score = 0;
    state.lap = 1;
    state.dist = 0;
    state.speed = 280;
    state.lane = 1;
    state.catX = laneX(1);
    state.hitT = 0;
    state.shakeT = 0;
    state.entities = [];
    state.particles = [];
    state.floaters = [];
    state.spawnAcc = 0;
    state.invuln = 0.6;
    state.combo = 1;
    state.finishFlash = 0;
    state._gates = 0;
    state._happyT = 0;
  }

  function beginPlay() {
    if (state.mode === "play") return;
    ensureAudio();
    resetRun();
    state.mode = "play";
    started = true;
    // seed a few items
    for (let i = 0; i < 6; i++) spawnWave(-200 - i * 180);
  }

  const OB_TYPES = ["cucumber", "vacuum", "yarn_pink", "yarn_blue"];
  const LOOT_TYPES = ["fish_coin", "fish_dry", "tuna"];

  function spawnWave(y) {
    const lane = Math.floor(Math.random() * LANES);
    const roll = Math.random();
    if (roll < 0.55) {
      const t = OB_TYPES[(Math.random() * OB_TYPES.length) | 0];
      state.entities.push({
        kind: "ob",
        type: t,
        lane,
        x: laneX(lane),
        y,
        r: t === "vacuum" ? 34 : t.includes("yarn") ? 28 : 26,
        vx: t === "vacuum" ? (Math.random() < 0.5 ? -40 : 40) : 0,
        passed: false,
        near: false,
      });
      // maybe loot in other lane
      if (Math.random() < 0.55) {
        let l2 = (lane + 1 + ((Math.random() * (LANES - 1)) | 0)) % LANES;
        const lt = LOOT_TYPES[(Math.random() * LOOT_TYPES.length) | 0];
        state.entities.push({
          kind: "loot",
          type: lt,
          lane: l2,
          x: laneX(l2),
          y: y - 40 - Math.random() * 50,
          r: lt === "tuna" ? 30 : 22,
          vx: 0,
          passed: false,
          near: false,
        });
      }
    } else {
      const lt = LOOT_TYPES[(Math.random() * LOOT_TYPES.length) | 0];
      state.entities.push({
        kind: "loot",
        type: lt,
        lane,
        x: laneX(lane),
        y,
        r: lt === "tuna" ? 30 : 22,
        vx: 0,
        passed: false,
        near: false,
      });
    }
  }

  function addFloater(text, x, y, color) {
    state.floaters.push({ text, x, y, t: 0.9, color: color || "#fff" });
  }

  function addBurst(x, y, n, colors) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 140;
      state.particles.push({
        kind: "star",
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.35,
        max: 0.75,
        color: colors[(Math.random() * colors.length) | 0],
        size: 3 + Math.random() * 4,
      });
    }
  }

  function addPaw(x, y) {
    state.particles.push({
      kind: "paw",
      x: x + (Math.random() - 0.5) * 18,
      y: y + 28,
      vx: 0,
      vy: 30,
      life: 0.55,
      max: 0.55,
      color: "#ff8fb8",
      size: 10,
    });
  }

  // ---- Update ----
  function update(dt) {
    state.titlePulse += dt;
    if (state.mode !== "play") return;

    const wantL = holdLeft || keys.has("L");
    const wantR = holdRight || keys.has("R");

    if (state.hitT > 0) {
      state.lane = 1;
      state.catX += (laneX(1) - state.catX) * Math.min(1, 10 * dt);
    } else if (wantL && !wantR) {
      state.catX = Math.max(laneX(0), state.catX - 260 * dt);
    } else if (wantR && !wantL) {
      state.catX = Math.min(laneX(LANES - 1), state.catX + 260 * dt);
    } else {
      let best = 0;
      let bestD = 1e9;
      for (let i = 0; i < LANES; i++) {
        const d = Math.abs(state.catX - laneX(i));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      state.lane = best;
      state.catX += (laneX(state.lane) - state.catX) * Math.min(1, 12 * dt);
    }
    {
      let best = 0;
      let bestD = 1e9;
      for (let i = 0; i < LANES; i++) {
        const d = Math.abs(state.catX - laneX(i));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      state.lane = best;
    }

    state.bob += dt * 10;
    state.speed = 280 + Math.min(160, state.dist * 0.02) + (state.lap - 1) * 25;
    const scroll = state.speed * dt;
    state.dist += scroll;

    // lap / finish gates (distance milestones)
    const crossed = Math.floor(state.dist / LAP_DIST);
    if (crossed > (state._gates || 0)) {
      const g = crossed;
      state._gates = g;
      state.finishFlash = 0.7;
      if (g < MAX_LAPS) {
        state.lap = g + 1;
        state.score += 500;
        sfxLap();
        addFloater("LAP " + state.lap + "!", W / 2, H * 0.35, "#ff6eb4");
      } else if (g === MAX_LAPS) {
        state.lap = MAX_LAPS;
        state.score += 1000;
        sfxLap();
        addFloater("FINISH!", W / 2, H * 0.32, "#ffd36e");
        state.finishFlash = 1.0;
      } else {
        state.lap = MAX_LAPS;
        state.score += 400;
        sfxLap();
        addFloater("BONUS LAP!", W / 2, H * 0.35, "#a78bfa");
      }
    }

    state.spawnAcc += scroll;
    while (state.spawnAcc > 160) {
      state.spawnAcc -= 160 + Math.random() * 40;
      let topY = -80;
      for (const e of state.entities) if (e.y < topY) topY = e.y;
      spawnWave(topY - 180 - Math.random() * 60);
    }

    if (state.hitT > 0) state.hitT -= dt;
    if (state.invuln > 0) state.invuln -= dt;
    if (state.shakeT > 0) state.shakeT -= dt;
    if (state.finishFlash > 0) state.finishFlash -= dt;

    // paw trail
    if (Math.random() < dt * 14) addPaw(state.catX, state.catY);

    sfxPurr(dt);

    const catR = 28;
    for (const e of state.entities) {
      e.y += scroll;
      if (e.vx) {
        e.x += e.vx * dt;
        if (e.x < laneX(0) - 10 || e.x > laneX(LANES - 1) + 10) e.vx *= -1;
      }
      const dy = e.y - state.catY;
      const dx = e.x - state.catX;
      const dist = Math.hypot(dx, dy);

      if (e.kind === "loot" && dist < catR + e.r * 0.7) {
        e.dead = true;
        const pts = (e.type === "tuna" ? 80 : e.type === "fish_coin" ? 40 : 25) * state.combo;
        state.score += pts | 0;
        sfxCollect();
        addBurst(e.x, e.y, 10, ["#ffd36e", "#fff1a8", "#ff9ecd"]);
        addFloater("+" + (pts | 0), e.x, e.y - 20, "#ffd36e");
        if (img.cat_happy) state._happyT = 0.35;
      }

      if (e.kind === "ob") {
        const hit = dist < catR + e.r * 0.65;
        if (hit && state.hitT <= 0 && state.invuln <= 0) {
          state.hitT = 0.3;
          state.invuln = 0.55;
          state.combo = 1;
          state.shakeT = 0.18;
          state.shakeMag = 7;
          sfxHit();
          addBurst(state.catX, state.catY, 12, ["#fff", "#ffe66d", "#ffb4d9"]);
          addFloater("嗷呜~", state.catX, state.catY - 40, "#ff8fab");
          e.dead = true;
        } else if (!e.near && !hit && Math.abs(dy) < 36 && dist < catR + e.r + 22 && dist > catR + e.r * 0.65) {
          e.near = true;
          state.combo = Math.min(8, state.combo + 1);
          const pts = 60 * state.combo;
          state.score += pts;
          state.shakeT = 0.1;
          state.shakeMag = 3;
          sfxNear();
          state.floaters.push({
            text: "CLOSE CALL!",
            x: state.catX,
            y: state.catY - 50,
            t: 0.85,
            color: "#7dd3fc",
            sprite: "close_call",
          });
          state.floaters.push({
            text: "MEOW!",
            x: state.catX + 30,
            y: state.catY - 80,
            t: 0.7,
            color: "#ffe66d",
            sprite: "meow",
          });
          if (img.cat_happy) state._happyT = 0.45;
        }
      }
    }

    state.entities = state.entities.filter((e) => !e.dead && e.y < H + 80);
    if (state._happyT > 0) state._happyT -= dt;

    for (const p of state.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 40 * dt;
      p.vx *= 0.98;
    }
    state.particles = state.particles.filter((p) => p.life > 0);

    for (const f of state.floaters) {
      f.t -= dt;
      f.y -= 36 * dt;
    }
    state.floaters = state.floaters.filter((f) => f.t > 0);

    // distance score trickle
    state.score += scroll * 0.05;
    window.__MEOW_SCORE__ = state.score;
    window.__MEOW_MODE__ = state.mode;
    window.__MEOW_ENTS__ = state.entities.length;
  }

  // ---- Draw helpers ----
  function drawImg(key, x, y, w, h, rot, alpha) {
    const im = img[key];
    if (!im || !im.complete) return;
    ctx.save();
    if (alpha != null) ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    ctx.drawImage(im, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawBg() {
    // mint field
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#c8f0e0");
    g.addColorStop(1, "#a8e0d0");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // scrolling track art
    const track = img.track;
    if (track && track.complete) {
      const tw = W * 0.92;
      const th = tw * (track.height / track.width);
      const offset = (state.mode === "play" ? state.dist : state.titlePulse * 40) % th;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.clip();
      for (let y = -offset; y < H + th; y += th) {
        ctx.drawImage(track, (W - tw) / 2, y, tw, th);
      }
      ctx.restore();
    } else {
      // fallback road
      ctx.fillStyle = "#f7d9a8";
      roundRoad(W * 0.18, 0, W * 0.64, H, 40);
      ctx.strokeStyle = "#f5a7c2";
      ctx.lineWidth = 14;
      ctx.stroke();
    }

    // soft vignette side bushes feel
    ctx.fillStyle = "rgba(255,182,210,0.08)";
    for (let i = 0; i < 8; i++) {
      const yy = ((i * 90 - (state.dist * 0.4)) % (H + 90));
      ctx.beginPath();
      ctx.ellipse(30, yy, 28, 18, 0, 0, Math.PI * 2);
      ctx.ellipse(W - 30, yy + 40, 26, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function roundRoad(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  function drawFinishArch() {
    // lap progress marker near top when approaching
    const inLap = state.dist % LAP_DIST;
    const remain = LAP_DIST - inLap;
    if (remain < 420) {
      const y = (remain / 420) * (state.catY - 40);
      ctx.save();
      // rainbow arch
      const colors = ["#ff8fab", "#ffd36e", "#9bf6ff", "#bdb2ff"];
      colors.forEach((c, i) => {
        ctx.strokeStyle = c;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(W / 2, y + 10, 70 - i * 8, Math.PI, 0);
        ctx.stroke();
      });
      // checkered
      const cw = 14;
      for (let i = 0; i < 10; i++) {
        ctx.fillStyle = i % 2 ? "#fff" : "#c084fc";
        ctx.fillRect(W / 2 - 70 + i * cw, y + 8, cw, 12);
      }
      ctx.restore();
    }
    if (state.finishFlash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${state.finishFlash * 0.35})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawEntity(e) {
    const bob = Math.sin(state.bob + e.y * 0.01) * 3;
    let key = e.type;
    let w = 56;
    let h = 56;
    if (e.type === "cucumber") { w = 44; h = 64; }
    if (e.type === "vacuum") { w = 70; h = 52; }
    if (e.type.includes("yarn")) { w = 54; h = 50; }
    if (e.type === "fish_coin") { w = 48; h = 46; }
    if (e.type === "fish_dry") { w = 50; h = 36; }
    if (e.type === "tuna") { w = 52; h = 64; }
    drawImg(key, e.x, e.y + bob, w, h, 0, 1);
  }

  function drawCat() {
    const bounce = Math.sin(state.bob) * 4;
    let key = "cat_normal";
    if (state.hitT > 0) key = "cat_dizzy";
    else if (state._happyT > 0) key = "cat_happy";

    // face up the track: rotate side-view sprite
    const rot = -Math.PI / 2;
    const scale = 0.92 + Math.sin(state.bob * 2) * 0.03;
    const w = 96 * scale;
    const h = 56 * scale;
    // shadow
    ctx.save();
    ctx.fillStyle = "rgba(80,60,40,0.18)";
    ctx.beginPath();
    ctx.ellipse(state.catX, state.catY + 34, 28, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (state.hitT > 0) {
      drawImg("fx_burst", state.catX, state.catY - 10, 70, 60, state.bob * 0.5, 0.9);
    }
    drawImg(key, state.catX, state.catY + bounce, w, h, rot, state.invuln > 0 && ((state.invuln * 20) | 0) % 2 === 0 ? 0.55 : 1);
    if (state.mode === "play") {
      drawImg("fx_lines", state.catX, state.catY + 40, 50, 16, 0, 0.55);
    }
  }

  function drawParticles() {
    for (const p of state.particles) {
      const a = Math.max(0, p.life / p.max);
      if (p.kind === "paw" && img.fx_paws) {
        drawImg("fx_paws", p.x, p.y, p.size * 2.2, p.size, 0, a * 0.7);
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - p.size);
        ctx.lineTo(p.x + p.size * 0.6, p.y);
        ctx.lineTo(p.x, p.y + p.size);
        ctx.lineTo(p.x - p.size * 0.6, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawUI() {
    if (state.mode === "play") {
      // candy HUD from sprite sheet + live numbers
      if (img.ui_lap) ctx.drawImage(img.ui_lap, 10, 10, 132, 26);
      ctx.font = "bold 20px Trebuchet MS, sans-serif";
      ctx.textAlign = "left";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#ffffff";
      ctx.fillStyle = "#ff6eb4";
      const lapText = `LAP ${Math.min(state.lap, MAX_LAPS)}/${MAX_LAPS}`;
      ctx.strokeText(lapText, 16, 56);
      ctx.fillText(lapText, 16, 56);

      if (img.ui_score) ctx.drawImage(img.ui_score, 10, 66, 96, 24);
      const scoreText = String(Math.floor(state.score)).padStart(5, "0");
      ctx.font = "bold 28px Trebuchet MS, sans-serif";
      ctx.fillStyle = "#e8a317";
      ctx.strokeText(scoreText, 16, 118);
      ctx.fillText(scoreText, 16, 118);

      if (state.combo > 1) {
        ctx.font = "bold 16px Trebuchet MS, sans-serif";
        ctx.fillStyle = "#a78bfa";
        ctx.strokeText("x" + state.combo + " COMBO", 16, 142);
        ctx.fillText("x" + state.combo + " COMBO", 16, 142);
      }
    }

    // paw buttons — bottom corners
    const pawY = H - 56;
    const pulse = 1 + Math.sin(state.titlePulse * 4) * 0.03;
    const aL = state.mode === "title" ? 0.7 : holdLeft || keys.has("L") ? 1 : 0.8;
    const aR = state.mode === "title" ? 0.7 : holdRight || keys.has("R") ? 1 : 0.8;
    drawImg("paw_l", 52, pawY, 78 * pulse, 74 * pulse, 0, aL);
    drawImg("paw_r", W - 52, pawY, 78 * pulse, 74 * pulse, 0, aR);

    for (const f of state.floaters) {
      const a = Math.min(1, f.t * 2);
      if (f.sprite && img[f.sprite]) {
        drawImg(f.sprite, f.x, f.y, f.sprite === "close_call" ? 120 : 90, f.sprite === "close_call" ? 86 : 56, 0, a);
      } else {
        ctx.globalAlpha = a;
        ctx.font = "bold 18px Trebuchet MS, sans-serif";
        ctx.textAlign = "center";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.fillStyle = f.color;
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillText(f.text, f.x, f.y);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawTitle() {
    // soft panel (avoid concept mockup UI ghosting)
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    roundRect(W * 0.1, H * 0.2, W * 0.8, H * 0.42, 24);
    ctx.fill();

    // use mid crop of concept as poster art (skip baked HUD band)
    if (img.concept) {
      const iw = img.concept.width;
      const ih = img.concept.height;
      const sx = iw * 0.15;
      const sy = ih * 0.28;
      const sw = iw * 0.7;
      const sh = ih * 0.4;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(img.concept, sx, sy, sw, sh, W * 0.18, H * 0.22, W * 0.64, H * 0.22);
      ctx.restore();
    }

    ctx.textAlign = "center";
    ctx.font = "bold 34px Trebuchet MS, sans-serif";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#ff6eb4";
    ctx.strokeText("MEOW DRIFT", W / 2, H * 0.28);
    ctx.fillText("MEOW DRIFT", W / 2, H * 0.28);

    ctx.font = "bold 16px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#5b8a7a";
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.strokeText("多巴胺猫猫跑道", W / 2, H * 0.28 + 28);
    ctx.fillText("多巴胺猫猫跑道", W / 2, H * 0.28 + 28);

    drawImg("cat_happy", W / 2, H * 0.48, 120, 70, -Math.PI / 2, 1);
    drawImg("fish_coin", W / 2 - 70, H * 0.5, 36, 34, 0, 0.95);
    drawImg("cucumber", W / 2 + 72, H * 0.5, 30, 44, 0, 0.95);

    const blink = 0.65 + Math.sin(state.titlePulse * 5) * 0.35;
    ctx.globalAlpha = blink;
    ctx.font = "bold 18px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#ff8fab";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.strokeText("Tap / Space to start", W / 2, H * 0.58);
    ctx.fillText("Tap / Space to start", W / 2, H * 0.58);
    ctx.globalAlpha = 1;

    ctx.font = "13px Trebuchet MS, sans-serif";
    ctx.fillStyle = "#4a7064";
    ctx.fillText("A / D or ← → or Paw buttons", W / 2, H * 0.63);
    ctx.fillText("Dodge cukes · Collect fish · 3 Laps", W / 2, H * 0.63 + 18);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    let sx = 0;
    let sy = 0;
    if (state.shakeT > 0) {
      sx = (Math.random() - 0.5) * state.shakeMag * 2;
      sy = (Math.random() - 0.5) * state.shakeMag * 2;
    }
    ctx.save();
    ctx.translate(sx, sy);

    drawBg();
    if (state.mode === "play") drawFinishArch();

    // sort entities by y for simple depth
    const ents = state.entities.slice().sort((a, b) => a.y - b.y);
    for (const e of ents) drawEntity(e);

    drawParticles();
    if (state.mode === "play") drawCat();
    else drawTitle();

    ctx.restore();
    drawUI();

    if (!ready) {
      ctx.fillStyle = "rgba(184,224,210,0.92)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ff6eb4";
      ctx.font = "bold 20px Trebuchet MS, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Loading treats…", W / 2, H / 2);
    }
  }

  // ---- HiDPI ----
  function fitCanvas() {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- Boot ----
  function loadAssets() {
    const pack = window.ASSETS || {};
    const keys = Object.keys(pack);
    if (!keys.length) {
      ready = true;
      return Promise.resolve();
    }
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
      ready = true;
    });
  }

  let last = performance.now();
  function loop(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.033) dt = 0.033;
    if (ready) update(dt);
    render();
    requestAnimationFrame(loop);
  }

  fitCanvas();
  window.addEventListener("resize", fitCanvas);
  bindInput();
  loadAssets().then(() => {
    // warm
  });
  requestAnimationFrame(loop);
})();
