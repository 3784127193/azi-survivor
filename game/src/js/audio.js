/* ============================================================
 * audio.js — 程序化音效（WebAudio 实时合成，无任何外部音频文件）
 * ============================================================ */
"use strict";

const SFX = {
  ctx: null, master: null, muted: false,

  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch (e) { this.ctx = null; }
  },
  resume() { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); },

  /* 基础音：振荡器 + 包络 */
  tone(freq, dur, type, vol, slideTo, delay) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || "square";
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },

  /* 基础噪声：用于打击/爆炸 */
  noise(dur, vol, lowcut, delay) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + (delay || 0);
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = lowcut || 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  },

  /* ---- 具体音效 ---- */
  shoot()      { this.tone(880 + Math.random() * 120, 0.07, "square", 0.08, 420); },
  smgShoot()   { this.tone(1200, 0.04, "square", 0.05, 700); },
  shotgun()    { this.noise(0.18, 0.32, 900); this.tone(180, 0.15, "sawtooth", 0.14, 60); },
  melee()      { this.noise(0.09, 0.16, 2400); this.tone(300, 0.08, "triangle", 0.1, 180); },
  swing()      { this.noise(0.13, 0.055, 1100); },
  smash()      { this.noise(0.22, 0.34, 700); this.tone(120, 0.22, "sawtooth", 0.2, 40); },
  boom()       { this.noise(0.4, 0.4, 500); this.tone(90, 0.4, "sawtooth", 0.25, 30); },
  hit()        { this.noise(0.06, 0.12, 3000); },
  enemyDie()   { this.tone(420, 0.12, "triangle", 0.09, 140); this.noise(0.1, 0.1, 1600); },
  pickup()     { this.tone(660, 0.05, "sine", 0.07); this.tone(990, 0.07, "sine", 0.07, null, 0.05); },
  hurt()       { this.tone(200, 0.2, "sawtooth", 0.22, 70); this.noise(0.12, 0.2, 800); },
  levelup()    { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.14, "square", 0.1, null, i * 0.07)); },
  buy()        { this.tone(784, 0.07, "square", 0.1); this.tone(1046, 0.1, "square", 0.1, null, 0.07); },
  sell()       { this.tone(600, 0.08, "square", 0.09, 300); },
  heal()       { this.tone(520, 0.1, "sine", 0.1); this.tone(780, 0.14, "sine", 0.1, null, 0.08); },
  waveStart()  { [392, 523, 659].forEach((f, i) => this.tone(f, 0.16, "triangle", 0.13, null, i * 0.1)); },
  waveClear()  { [659, 784, 988, 1318].forEach((f, i) => this.tone(f, 0.15, "triangle", 0.12, null, i * 0.09)); },
  chest()      { [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.13, "square", 0.09, null, i * 0.06)); },
  gameover()   { [440, 349, 293, 220].forEach((f, i) => this.tone(f, 0.3, "sawtooth", 0.12, null, i * 0.22)); },
  victory()    { [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.2, "square", 0.11, null, i * 0.12)); },
  click()      { this.tone(700, 0.05, "square", 0.08); }
};
