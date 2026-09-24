"use strict";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const g = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

const ui = {
  file: $("file"), drop: $("drop"), fileName: $("fileName"), url: $("url"),
  speed: $("speed"), intensity: $("intensity"), reverb: $("reverb"),
  speedOut: $("speedOut"), intensityOut: $("intensityOut"), reverbOut: $("reverbOut"),
  scenes: $("scenes"), title: $("title"), artist: $("artist"), showHead: $("showHead"),
  start: $("start"), startOut: $("startOut"), duration: $("duration"), excerptInfo: $("excerptInfo"),
  play: $("play"), exportBtn: $("export"), cancel: $("cancel"),
  progress: $("progress"), progressBar: $("progressBar"), progressText: $("progressText"),
  download: $("download"), format: $("format"),
};

// ---------- Audio graph ----------
// source ─┬─ lowpass ─────────────────────────────── bass (centre) ─┐
//         └─ highpass ─┬─ panner (HRTF) ─ gain(intensité) ─┐       ├─ master ─┬─ destination
//                      └─ gain(1 - intensité) ─────────────┴─ mix ─┤          └─ recDest
//                                                 mix ─ convolver ─┘
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const CROSSOVER = 120;

const lowpass = new BiquadFilterNode(ctx, { type: "lowpass", frequency: CROSSOVER, Q: 0.7 });
const highpass = new BiquadFilterNode(ctx, { type: "highpass", frequency: CROSSOVER, Q: 0.7 });
const panner = new PannerNode(ctx, {
  panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, rolloffFactor: 0,
  channelCount: 1, channelCountMode: "explicit",
});
const pannedGain = new GainNode(ctx);
const centerGain = new GainNode(ctx);
const mix = new GainNode(ctx);
const convolver = new ConvolverNode(ctx, { buffer: makeImpulse(2.8, 2.5) });
const wetGain = new GainNode(ctx);
const bassGain = new GainNode(ctx, { gain: 1 });
const master = new GainNode(ctx, { gain: 0.9 });
const analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.6 });
const recDest = ctx.createMediaStreamDestination();

lowpass.connect(bassGain).connect(master);
highpass.connect(panner).connect(pannedGain).connect(mix);
highpass.connect(centerGain).connect(mix);
mix.connect(master);
mix.connect(convolver).connect(wetGain).connect(master);
master.connect(ctx.destination);
master.connect(recDest);

function makeImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function applyMix() {
  const k = +ui.intensity.value;
  const r = +ui.reverb.value;
  const t = ctx.currentTime;
  pannedGain.gain.setTargetAtTime(k, t, 0.05);
  centerGain.gain.setTargetAtTime(1 - k, t, 0.05);
  wetGain.gain.setTargetAtTime(r * 0.8, t, 0.05);
  mix.gain.setTargetAtTime(1 - r * 0.35, t, 0.05);
}

// ---------- Track state ----------
let buffer = null;
let source = null;
let playing = false;
let angle = 0;
let playStartCtx = 0; // ctx time when the current excerpt started
let excerpt = { start: 0, length: 30 };

function stopSource() {
  if (source) {
    source.onended = null;
    try { source.stop(); } catch (_) {}
    source.disconnect();
    source = null;
  }
  playing = false;
  ui.play.textContent = "▶ Écouter";
}

function startSource(onEnd) {
  stopSource();
  computeExcerpt();
  source = new AudioBufferSourceNode(ctx, { buffer });
  source.connect(lowpass);
  source.connect(highpass);
  source.connect(analyser);
  angle = 0;
  playStartCtx = ctx.currentTime + 0.05;
  source.start(playStartCtx, excerpt.start, excerpt.length);
  source.onended = () => { stopSource(); onEnd && onEnd(); };
  playing = true;
  ui.play.textContent = "■ Stop";
}

function computeExcerpt() {
  if (!buffer) return;
  const total = buffer.duration;
  if (ui.duration.value === "full") {
    excerpt = { start: 0, length: total };
  } else {
    const len = Math.min(+ui.duration.value, total);
    const start = Math.min(+ui.start.value, Math.max(0, total - len));
    excerpt = { start, length: len };
  }
  ui.start.disabled = ui.duration.value === "full";
  ui.excerptInfo.textContent =
    `Extrait : ${fmt(excerpt.start)} → ${fmt(excerpt.start + excerpt.length)} (${fmt(excerpt.length)}) sur ${fmt(total)}`;
}

function fmt(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setBuffer(buf, name) {
  stopSource();
  buffer = buf;
  ui.start.max = Math.max(0, buf.duration - 1).toFixed(1);
  ui.start.value = 0;
  ui.startOut.textContent = fmt(0);
  ui.fileName.textContent = name;
  computeExcerpt();
}

// ---------- Demo track (synthesised, no external file) ----------
async function makeDemo() {
  const sr = 44100, dur = 32;
  const off = new OfflineAudioContext(2, sr * dur, sr);
  const out = new GainNode(off, { gain: 0.5 });
  out.connect(off.destination);
  const bpm = 96, beat = 60 / bpm;
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  for (let bar = 0; bar * beat * 4 < dur; bar++) {
    const t0 = bar * beat * 4;
    const ch = chords[bar % 4];
    // pad
    const lp = new BiquadFilterNode(off, { type: "lowpass", frequency: 1400 });
    const pg = new GainNode(off, { gain: 0 });
    lp.connect(pg).connect(out);
    pg.gain.linearRampToValueAtTime(0.18, t0 + 0.4);
    pg.gain.setValueAtTime(0.18, t0 + beat * 4 - 0.2);
    pg.gain.linearRampToValueAtTime(0, t0 + beat * 4);
    ch.forEach((m, i) => {
      [-6, 6].forEach((det) => {
        const o = new OscillatorNode(off, { type: "sawtooth", frequency: hz(m), detune: det });
        o.connect(lp); o.start(t0); o.stop(t0 + beat * 4);
      });
    });
    // arpeggio
    for (let s = 0; s < 8; s++) {
      const ts = t0 + s * beat / 2;
      const o = new OscillatorNode(off, { type: "triangle", frequency: hz(ch[s % 3] + 12 + (s >= 4 ? 12 : 0)) });
      const ag = new GainNode(off, { gain: 0 });
      o.connect(ag).connect(out);
      ag.gain.setValueAtTime(0, ts);
      ag.gain.linearRampToValueAtTime(0.22, ts + 0.01);
      ag.gain.exponentialRampToValueAtTime(0.001, ts + beat / 2);
      o.start(ts); o.stop(ts + beat / 2);
    }
    // bass
    const b = new OscillatorNode(off, { type: "sine", frequency: hz(ch[0] - 24) });
    const bg = new GainNode(off, { gain: 0.5 });
    b.connect(bg).connect(out); b.start(t0); b.stop(t0 + beat * 4);
    // kick + hat
    for (let k = 0; k < 4; k++) {
      const tk = t0 + k * beat;
      const ko = new OscillatorNode(off, { type: "sine", frequency: 140 });
      const kg = new GainNode(off, { gain: 0 });
      ko.connect(kg).connect(out);
      ko.frequency.exponentialRampToValueAtTime(40, tk + 0.15);
      kg.gain.setValueAtTime(1, tk);
      kg.gain.exponentialRampToValueAtTime(0.001, tk + 0.35);
      ko.start(tk); ko.stop(tk + 0.4);

      const th = tk + beat / 2;
      const nb = off.createBuffer(1, sr * 0.05, sr);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
      const ns = new AudioBufferSourceNode(off, { buffer: nb });
      const hp = new BiquadFilterNode(off, { type: "highpass", frequency: 7000 });
      const hg = new GainNode(off, { gain: 0.12 });
      ns.connect(hp).connect(hg).connect(out); ns.start(th);
    }
  }
  return off.startRendering();
}

// ---------- Scenes ----------
const rand = mulberry32(8);
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const stars = Array.from({ length: 220 }, () => ({
  x: rand() * W, y: rand() * H * 0.65, r: rand() * 2.4 + 0.5, p: rand() * Math.PI * 2,
}));
const grains = Array.from({ length: 90 }, () => ({ x: rand() * W, y: H * 0.5 + rand() * H * 0.5, s: rand() * 2 + 1 }));

function vGrad(stops, y0 = 0, y1 = H) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  return gr;
}

function drawStars(t, bass, alpha = 1) {
  for (const s of stars) {
    const tw = 0.5 + 0.5 * Math.sin(t * 2 + s.p);
    g.globalAlpha = alpha * (0.3 + 0.7 * tw) * (0.8 + bass * 0.4);
    g.fillStyle = "#fff";
    g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

function ridge(baseY, amp, freq, seed, color, t = 0, speed = 0) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += 12) {
    const u = x / W * freq + seed + t * speed;
    const y = baseY - amp * (0.55 * Math.abs(Math.sin(u)) + 0.3 * Math.sin(u * 2.3 + seed) + 0.15 * Math.sin(u * 5.1));
    g.lineTo(x, y);
  }
  g.lineTo(W, H);
  g.closePath();
  g.fill();
}

const scenes = [
  {
    id: "boreale", name: "Nuit boréale",
    draw(t, bass) {
      g.fillStyle = vGrad([[0, "#020617"], [0.55, "#0b1f3a"], [1, "#04111d"]]);
      g.fillRect(0, 0, W, H);
      drawStars(t, bass);
      g.globalCompositeOperation = "lighter";
      const bands = [["#22ffb0", 0], ["#3d9bff", 1.7], ["#b25cff", 3.1]];
      for (const [col, ph] of bands) {
        for (let x = 0; x <= W; x += 6) {
          const y = 520 + ph * 70 + Math.sin(x / 260 + t * 0.5 + ph) * 110 + Math.sin(x / 90 + t * 1.3) * 25;
          const h = 260 + 160 * Math.sin(x / 180 + t * 0.7 + ph) + bass * 260;
          const gr = g.createLinearGradient(0, y - h, 0, y);
          gr.addColorStop(0, "rgba(0,0,0,0)");
          gr.addColorStop(1, col);
          g.globalAlpha = 0.07 + bass * 0.08;
          g.fillStyle = gr;
          g.fillRect(x, y - h, 6, h);
        }
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      ridge(1320, 260, 3, 1, "#0a1628");
      ridge(1480, 180, 5, 4, "#050d19");
      g.fillStyle = vGrad([[0, "#08182c"], [1, "#02060c"]], 1480, H);
      g.fillRect(0, 1560, W, H - 1560);
    },
  },
  {
    id: "neon", name: "Horizon néon",
    draw(t, bass) {
      const hz = 1080;
      g.fillStyle = vGrad([[0, "#12002b"], [0.45, "#4a0a6b"], [0.56, "#ff3d9a"], [0.5625, "#12002b"], [1, "#0a0018"]]);
      g.fillRect(0, 0, W, H);
      drawStars(t, bass, 0.6);
      // sun
      const r = 300 + bass * 40;
      const cx = W / 2, cy = hz - 120;
      g.save();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
      g.fillStyle = vGrad([[0, "#ffe66d"], [1, "#ff2e88"]], cy - r, cy + r);
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
      g.fillStyle = "#2a0845";
      for (let i = 0; i < 7; i++) {
        const y = cy + 20 + i * 38 + ((t * 20) % 38);
        g.fillRect(cx - r, y, r * 2, 4 + i * 2.5);
      }
      g.restore();
      g.shadowColor = "#ff2e88"; g.shadowBlur = 60 + bass * 80;
      g.strokeStyle = "rgba(255,46,136,0.6)"; g.lineWidth = 4;
      g.beginPath(); g.arc(cx, cy, r, Math.PI, 0); g.stroke();
      g.shadowBlur = 0;
      // ground + grid
      g.fillStyle = "#0a0018";
      g.fillRect(0, hz, W, H - hz);
      g.strokeStyle = `rgba(61,224,255,${0.55 + bass * 0.45})`;
      g.lineWidth = 3;
      g.shadowColor = "#3de0ff"; g.shadowBlur = 18;
      for (let i = -14; i <= 14; i++) {
        g.beginPath(); g.moveTo(cx + i * 20, hz); g.lineTo(cx + i * 260, H); g.stroke();
      }
      const off = (t * 0.6) % 1;
      for (let i = 0; i < 16; i++) {
        const p = (i + off) / 16;
        const y = hz + Math.pow(p, 2.2) * (H - hz);
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      g.shadowBlur = 0;
    },
  },
  {
    id: "aube", name: "Sommets à l'aube",
    draw(t, bass) {
      g.fillStyle = vGrad([[0, "#2b3a67"], [0.35, "#b86b8a"], [0.55, "#ffb88a"], [1, "#ffe0b0"]]);
      g.fillRect(0, 0, W, H);
      const sy = 900 - Math.sin(t * 0.05) * 40;
      const glow = g.createRadialGradient(W / 2, sy, 20, W / 2, sy, 520 + bass * 200);
      glow.addColorStop(0, "rgba(255,245,210,1)");
      glow.addColorStop(0.2, "rgba(255,210,150,0.7)");
      glow.addColorStop(1, "rgba(255,180,120,0)");
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
      ridge(1040, 380, 2.2, 2, "rgba(122,86,130,0.85)", t, 0.01);
      ridge(1220, 330, 3, 5, "rgba(88,60,104,0.9)", t, 0.02);
      // mist
      for (let i = 0; i < 3; i++) {
        const y = 1260 + i * 90;
        g.fillStyle = vGrad([[0, "rgba(255,230,220,0)"], [0.5, `rgba(255,230,220,${0.18 + bass * 0.12})`], [1, "rgba(255,230,220,0)"]], y - 60, y + 60);
        g.fillRect(0, y - 60, W, 120);
      }
      ridge(1450, 280, 4, 9, "#3b2748", t, 0.035);
      ridge(1680, 200, 6, 3, "#1f1428", t, 0.05);
    },
  },
  {
    id: "lune", name: "Mer de lune",
    draw(t, bass) {
      const hz = 1150;
      g.fillStyle = vGrad([[0, "#030712"], [0.6, "#112240"], [1, "#050b18"]]);
      g.fillRect(0, 0, W, H);
      drawStars(t, bass);
      const mx = W * 0.62, my = 560, mr = 150 + bass * 12;
      const halo = g.createRadialGradient(mx, my, mr, mx, my, mr * 3.5);
      halo.addColorStop(0, "rgba(200,220,255,0.35)");
      halo.addColorStop(1, "rgba(200,220,255,0)");
      g.fillStyle = halo; g.fillRect(0, 0, W, hz);
      g.fillStyle = "#eef3ff";
      g.beginPath(); g.arc(mx, my, mr, 0, Math.PI * 2); g.fill();
      g.fillStyle = "rgba(170,185,215,0.5)";
      [[-40, -30, 28], [50, 30, 20], [-10, 60, 16], [30, -60, 12]].forEach(([dx, dy, r]) => {
        g.beginPath(); g.arc(mx + dx, my + dy, r, 0, Math.PI * 2); g.fill();
      });
      g.fillStyle = vGrad([[0, "#0c1d3a"], [1, "#02060f"]], hz, H);
      g.fillRect(0, hz, W, H - hz);
      // reflection shimmer
      for (let i = 0; i < 60; i++) {
        const p = i / 60;
        const y = hz + 10 + p * p * (H - hz);
        const w = (40 + p * 260) * (0.6 + 0.4 * Math.sin(t * 3 + i * 1.7)) * (1 + bass * 0.6);
        g.fillStyle = `rgba(220,235,255,${0.5 * (1 - p)})`;
        g.fillRect(mx - w / 2 + Math.sin(t * 2 + i) * 20 * p, y, w, 3 + p * 6);
      }
      // wave lines
      g.strokeStyle = "rgba(120,160,220,0.25)"; g.lineWidth = 2;
      for (let i = 0; i < 18; i++) {
        const y0 = hz + 30 + Math.pow(i / 18, 1.8) * (H - hz);
        g.beginPath();
        for (let x = 0; x <= W; x += 20) {
          const y = y0 + Math.sin(x / (60 + i * 8) + t * (1 + i * 0.1)) * (2 + i * 0.8) * (1 + bass);
          x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    },
  },
  {
    id: "dunes", name: "Dunes",
    draw(t, bass) {
      g.fillStyle = vGrad([[0, "#1d2b64"], [0.4, "#f8a55f"], [0.62, "#ffd89b"], [1, "#e08a4c"]]);
      g.fillRect(0, 0, W, H);
      const sx = W * 0.35, sy = 820;
      const sun = g.createRadialGradient(sx, sy, 0, sx, sy, 360 + bass * 150);
      sun.addColorStop(0, "rgba(255,250,220,1)");
      sun.addColorStop(0.25, "rgba(255,220,150,0.8)");
      sun.addColorStop(1, "rgba(255,200,120,0)");
      g.fillStyle = sun; g.fillRect(0, 0, W, H);
      const dune = (base, amp, fr, seed, c1, c2, sp) => {
        g.fillStyle = vGrad([[0, c1], [1, c2]], base - amp, H);
        g.beginPath(); g.moveTo(0, H);
        for (let x = 0; x <= W; x += 10) {
          const u = x / W * fr + seed + t * sp;
          g.lineTo(x, base - amp * (0.6 * Math.sin(u) + 0.4 * Math.sin(u * 0.47 + seed)));
        }
        g.lineTo(W, H); g.closePath(); g.fill();
      };
      dune(1150, 120, 3, 1, "#e9a35e", "#b86a35", 0.01);
      dune(1320, 150, 2.4, 3, "#d98a4a", "#9c522a", 0.02);
      dune(1540, 170, 2, 6, "#c4733a", "#7a3b1c", 0.035);
      dune(1760, 150, 1.6, 2, "#a85c2d", "#5a2a12", 0.05);
      g.fillStyle = "rgba(255,230,190,0.55)";
      for (const p of grains) {
        const x = (p.x + t * 60 * p.s * (1 + bass)) % W;
        const y = p.y + Math.sin(t * 2 + p.x) * 10;
        g.fillRect(x, y, p.s * 2, p.s);
      }
    },
  },
];
let scene = scenes[0];

// ---------- Overlay ----------
function roundRect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitText(text, maxW, size, weight) {
  let s = size;
  do { g.font = `${weight} ${s}px Outfit, system-ui, sans-serif`; s -= 4; }
  while (g.measureText(text).width > maxW && s > 28);
}

function drawOverlay(bass) {
  g.textAlign = "center";
  g.textBaseline = "middle";

  // badge
  const bw = 360, bh = 96, bx = (W - bw) / 2, by = 170;
  g.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(bx, by, bw, bh, 48); g.fill();
  g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 4;
  roundRect(bx, by, bw, bh, 48); g.stroke();
  g.fillStyle = "#fff";
  g.font = "800 52px Outfit, system-ui, sans-serif";
  g.fillText("8D AUDIO", W / 2, by + bh / 2 + 2);
  g.font = "600 38px Outfit, system-ui, sans-serif";
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.fillText("🎧 Mets tes écouteurs", W / 2, by + bh + 64);

  // head diagram
  if (ui.showHead.checked) {
    const cx = W / 2, cy = 1330, R = 190;
    g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 3;
    g.setLineDash([10, 14]);
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    // head (top = front)
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath(); g.ellipse(cx, cy, 58, 66, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(cx - 14, cy - 62); g.lineTo(cx, cy - 86); g.lineTo(cx + 14, cy - 62); g.fill();
    g.beginPath(); g.ellipse(cx - 60, cy, 12, 22, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + 60, cy, 12, 22, 0, 0, Math.PI * 2); g.fill();
    // sound source
    const px = cx + R * Math.sin(angle), py = cy - R * Math.cos(angle);
    const pr = 26 + bass * 16;
    const glow = g.createRadialGradient(px, py, 0, px, py, pr * 3);
    glow.addColorStop(0, "rgba(61,224,208,0.9)");
    glow.addColorStop(1, "rgba(61,224,208,0)");
    g.fillStyle = glow;
    g.beginPath(); g.arc(px, py, pr * 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#3de0d0";
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#06201d";
    g.font = `800 ${Math.round(pr)}px Outfit, system-ui, sans-serif`;
    g.fillText("♪", px, py + 2);
  }

  // title / artist
  const title = ui.title.value.trim();
  const artist = ui.artist.value.trim();
  g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = 24;
  if (title) {
    fitText(title, W - 160, 92, 800);
    g.fillStyle = "#fff";
    g.fillText(title, W / 2, 1640);
  }
  if (artist) {
    fitText(artist, W - 200, 56, 600);
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.fillText(artist, W / 2, 1735);
  }
  g.shadowBlur = 0;
}

// ---------- Render loop ----------
const freq = new Uint8Array(analyser.frequencyBinCount);
let bassLevel = 0;
let lastFrame = performance.now();
const clock0 = performance.now();

function readBass() {
  if (!playing) return 0;
  analyser.getByteFrequencyData(freq);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const maxBin = Math.max(2, Math.floor(150 / binHz));
  let sum = 0;
  for (let i = 1; i <= maxBin; i++) sum += freq[i];
  return Math.min(1, Math.max(0, (sum / maxBin / 255 - 0.35) / 0.55));
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = (now - clock0) / 1000;

  const target = readBass();
  bassLevel += (target - bassLevel) * (target > bassLevel ? 0.5 : 0.12);

  if (playing) {
    angle += (dt * Math.PI * 2) / +ui.speed.value;
    const x = Math.sin(angle), z = -Math.cos(angle), y = 0.15 * Math.sin(angle * 0.5);
    const at = ctx.currentTime;
    panner.positionX.setTargetAtTime(x, at, 0.015);
    panner.positionY.setTargetAtTime(y, at, 0.015);
    panner.positionZ.setTargetAtTime(z, at, 0.015);
  }

  scene.draw(t, bassLevel);
  drawOverlay(bassLevel);
  if (recording) updateProgress();
  requestAnimationFrame(frame);
}

// ---------- Export ----------
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const mime = window.MediaRecorder
  ? MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || ""
  : "";
const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
ui.format.textContent = mime ? `${ext.toUpperCase()} 1080×1920` : "export non pris en charge par ce navigateur";
if (!mime) ui.exportBtn.disabled = true;

let recording = null;

function updateProgress() {
  const el = Math.max(0, ctx.currentTime - playStartCtx);
  const p = Math.min(1, el / excerpt.length);
  ui.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
  ui.progressText.textContent = `Enregistrement… ${fmt(el)} / ${fmt(excerpt.length)}`;
}

async function startExport() {
  if (!buffer || recording) return;
  await ctx.resume();
  await document.fonts.ready;
  if (ui.download.href) URL.revokeObjectURL(ui.download.href);
  ui.download.hidden = true;

  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...recDest.stream.getAudioTracks(),
  ]);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  recording = { rec, cancelled: false };
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getVideoTracks().forEach((tr) => tr.stop());
    const cancelled = recording.cancelled;
    recording = null;
    setBusy(false);
    if (cancelled) return;
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    const base = (ui.title.value.trim() || "orbite-8d").replace(/[^\p{L}\p{N}\- ]/gu, "").trim().replace(/\s+/g, "-");
    ui.download.href = URL.createObjectURL(blob);
    ui.download.download = `${base}-8d.${ext}`;
    ui.download.textContent = `Télécharger la vidéo (${(blob.size / 1e6).toFixed(1)} Mo)`;
    ui.download.hidden = false;
  };

  setBusy(true);
  rec.start(1000);
  startSource(() => { if (rec.state !== "inactive") rec.stop(); });
}

function cancelExport() {
  if (!recording) return;
  recording.cancelled = true;
  stopSource();
  if (recording.rec.state !== "inactive") recording.rec.stop();
}

function setBusy(busy) {
  ui.progress.hidden = !busy;
  ui.exportBtn.disabled = busy;
  ui.play.disabled = busy;
  ui.file.disabled = busy;
  ui.url.disabled = busy;
  $("urlBtn").disabled = busy;
  ui.start.disabled = busy || ui.duration.value === "full";
  ui.duration.disabled = busy;
  if (!busy) ui.progressBar.style.width = "0";
}

document.addEventListener("visibilitychange", () => {
  if (recording && document.hidden) {
    ui.progressText.textContent = "Onglet en arrière-plan : la vidéo risque de figer. Reviens ici.";
  }
});

// ---------- UI wiring ----------
function syncOutputs() {
  ui.speedOut.textContent = `${(+ui.speed.value).toFixed(1)} s / tour`;
  ui.intensityOut.textContent = `${Math.round(ui.intensity.value * 100)} %`;
  ui.reverbOut.textContent = `${Math.round(ui.reverb.value * 100)} %`;
  applyMix();
}
[ui.speed, ui.intensity, ui.reverb].forEach((el) => el.addEventListener("input", syncOutputs));

ui.start.addEventListener("input", () => {
  ui.startOut.textContent = fmt(+ui.start.value);
  computeExcerpt();
});
ui.duration.addEventListener("change", computeExcerpt);

scenes.forEach((s) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = s.name;
  b.classList.toggle("active", s === scene);
  b.addEventListener("click", () => {
    scene = s;
    [...ui.scenes.children].forEach((c) => c.classList.toggle("active", c === b));
  });
  ui.scenes.appendChild(b);
});

ui.play.addEventListener("click", async () => {
  await ctx.resume();
  if (playing) stopSource();
  else if (buffer) startSource();
});
ui.exportBtn.addEventListener("click", startExport);
ui.cancel.addEventListener("click", cancelExport);

async function loadFile(file) {
  if (!file) return;
  ui.fileName.textContent = "Décodage…";
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    setBuffer(buf, file.name);
    ui.title.value = file.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").slice(0, 60);
    ui.artist.value = "";
  } catch (e) {
    ui.fileName.textContent = "Fichier illisible. Essaie un mp3, m4a ou wav.";
  }
}
ui.file.addEventListener("change", () => loadFile(ui.file.files[0]));

// ---------- Import par lien ----------
const URL_HINT = "Lien direct vers un fichier audio, ou lien de partage Dropbox.";

function urlMessage(text, isError) {
  const el = $("urlMsg");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

// Rewrites share links into URLs that serve the raw file with CORS headers.
function normalizeAudioUrl(raw) {
  const u = new URL(raw.trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error("protocol");
  const host = u.hostname.replace(/^www\./, "");
  if (/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(host)) throw new Error("youtube");
  if (host === "dropbox.com") {
    u.hostname = "dl.dropboxusercontent.com";
    u.searchParams.delete("dl");
  }
  const drive = host === "drive.google.com" && u.pathname.match(/\/file\/d\/([^/]+)/);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download`;
  return u.toString();
}

async function loadUrl(raw) {
  let url;
  try {
    url = normalizeAudioUrl(raw);
  } catch (e) {
    urlMessage(e.message === "youtube"
      ? "Les liens YouTube ne sont pas pris en charge. Utilise un lien vers un fichier audio."
      : "Lien invalide.", true);
    return;
  }
  const btn = $("urlBtn");
  btn.disabled = true;
  urlMessage("Téléchargement…");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (type.startsWith("text/html")) throw new Error("html");
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const name = decodeURIComponent(new URL(raw).pathname.split("/").pop() || "audio");
    setBuffer(buf, name);
    ui.title.value = name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").slice(0, 60);
    ui.artist.value = "";
    urlMessage(URL_HINT);
  } catch (e) {
    urlMessage(e instanceof TypeError
      ? "Le site qui héberge ce fichier bloque son chargement depuis une autre page. Essaie un lien Dropbox ou un autre hébergeur."
      : e.message === "html"
        ? "Ce lien mène à une page web, pas à un fichier audio."
        : "Impossible de lire ce fichier audio.", true);
  } finally {
    btn.disabled = false;
  }
}

$("urlForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (ui.url.value.trim()) loadUrl(ui.url.value);
});
["dragenter", "dragover"].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.remove("over"); }));
ui.drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

// ---------- Boot ----------
ui.title.value = "Démo Orbite";
ui.artist.value = "Orbite 8D";
syncOutputs();
requestAnimationFrame(frame);
makeDemo().then((buf) => { if (!buffer) setBuffer(buf, "Son démo chargé"); });
