const $ = (id) => document.getElementById(id);

const STORAGE = 'sloth-branch-balance:v1';

function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function pad2(n){ return String(n).padStart(2,'0'); }

function todaySeed(){
  const d = new Date();
  const y = d.getFullYear();
  const m = pad2(d.getMonth()+1);
  const day = pad2(d.getDate());
  return `${y}${m}${day}`;
}

function mulberry32(a){
  let t = a >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s){
  let h = 2166136261;
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function defaultState(){
  return {
    best: null,
    diff: 'normal',
    visuals: 'on',
    sound: true,
    daily: true,
  };
}

function load(){
  try{
    const raw = localStorage.getItem(STORAGE);
    if(!raw) return defaultState();
    const j = JSON.parse(raw);
    return { ...defaultState(), ...j };
  } catch { return defaultState(); }
}

let state = load();
function save(){ localStorage.setItem(STORAGE, JSON.stringify(state)); }

// Audio: gentle wind
let audio = { ctx:null, node:null, gain:null };
function ensureAudio(){
  if(!state.sound) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if(!Ctx) return;
  if(audio.ctx) return;
  const ctx = new Ctx();
  const bufferSize = 2 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const out = buffer.getChannelData(0);
  for(let i=0;i<bufferSize;i++) out[i] = (Math.random()*2-1);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;

  const g = ctx.createGain();
  g.gain.value = 0.0001;

  src.connect(lp);
  lp.connect(g);
  g.connect(ctx.destination);
  src.start();

  // fade in
  const t0 = ctx.currentTime;
  g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.25);

  audio = { ctx, node: src, gain: g };
}

function stopAudio(){
  try{ audio.node?.stop?.(); } catch{}
  try{ audio.ctx?.close?.(); } catch{}
  audio = { ctx:null, node:null, gain:null };
}

// Game sim
const canvas = $('game');
const ctx = canvas.getContext('2d');

let sim = {
  running: false,
  t: 0,
  remaining: 60,
  seed: todaySeed(),
  rand: mulberry32(hashStr(todaySeed())),
  // branch angle dynamics
  angle: 0,
  vel: 0,
  // wind parameters
  windPhase: 0,
  interventions: 0,
  wobbleAcc: 0,
  stillAcc: 0,
};

function diffParams(){
  if(state.diff === 'easy') return { wind: 0.55, damp: 0.985, nudge: 0.22 };
  if(state.diff === 'hard') return { wind: 1.05, damp: 0.975, nudge: 0.18 };
  return { wind: 0.80, damp: 0.98, nudge: 0.20 };
}

function resetSim(){
  const seed = state.daily ? todaySeed() : String(Date.now());
  sim = {
    running: false,
    t: 0,
    remaining: 60,
    seed,
    rand: mulberry32(hashStr(seed)),
    angle: 0,
    vel: 0,
    windPhase: sim.rand?.() || 0,
    interventions: 0,
    wobbleAcc: 0,
    stillAcc: 0,
  };
  $('time').textContent = '60';
  $('still').textContent = '0';
  $('wobble').textContent = '0';
}

function setBestUI(){
  $('best').textContent = state.best ? `${state.best.score.toFixed(1)} (seed ${state.best.seed})` : '—';
}

function start(){
  resetSim();
  sim.running = true;
  $('btnShare').disabled = true;
  ensureAudio();
  requestAnimationFrame(loop);
}

function nudge(dir){
  if(!sim.running) return;
  const { nudge } = diffParams();
  sim.vel += dir * nudge;
  sim.interventions += 1;
}

canvas.addEventListener('pointerdown', (e) => {
  // nudge based on click position
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const dir = x < 0.5 ? -1 : 1;
  nudge(dir);
});

document.addEventListener('keydown', (e) => {
  if(e.key === 'ArrowLeft') nudge(-1);
  if(e.key === 'ArrowRight') nudge(1);
});

function windForce(t){
  const { wind } = diffParams();
  // daily pattern: two sine waves + gentle random drift
  const a = Math.sin(t*0.7 + sim.windPhase) * 0.6;
  const b = Math.sin(t*1.3 + sim.windPhase*1.8) * 0.35;
  const c = (sim.rand() - 0.5) * 0.06;
  return (a + b + c) * wind;
}

function step(dt){
  const { damp } = diffParams();

  const w = windForce(sim.t);
  // simple dynamics
  sim.vel += w * dt;
  // gravity-like pull to center
  sim.vel += (-sim.angle) * 0.9 * dt;
  sim.vel *= Math.pow(damp, dt*60);
  sim.angle += sim.vel * dt;

  // metrics
  const wob = Math.abs(sim.angle);
  sim.wobbleAcc += wob * dt;

  // stillness: penalize interventions; reward low motion and low wobble
  const motion = Math.abs(sim.vel);
  const calm = clamp(1.0 - (wob*1.4 + motion*0.35), 0, 1);
  sim.stillAcc += calm * dt;

  sim.t += dt;
  sim.remaining = Math.max(0, 60 - sim.t);
}

function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // background gradient
  const g = ctx.createLinearGradient(0,0,0,canvas.height);
  g.addColorStop(0, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,canvas.width,canvas.height);

  const cx = canvas.width/2;
  const cy = canvas.height*0.62;

  // draw branch
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(sim.angle);

  // branch body
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(242,247,255,0.18)';
  ctx.lineWidth = 26;
  ctx.beginPath();
  ctx.moveTo(-360, 0);
  ctx.lineTo(360, 0);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(123,211,137,0.25)';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(-330, 0);
  ctx.lineTo(330, 0);
  ctx.stroke();

  // sloth body
  const slothX = 0;
  const slothY = -44;
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(slothX, 18, 80, 18, 0, 0, Math.PI*2);
  ctx.fill();

  // sloth blob
  ctx.fillStyle = 'rgba(123,211,137,0.92)';
  roundRect(ctx, slothX-70, slothY-42, 140, 92, 34);
  ctx.fill();

  // face
  ctx.fillStyle = 'rgba(11,15,20,0.55)';
  ctx.beginPath();
  ctx.ellipse(slothX, slothY+2, 46, 30, 0, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = '#0b0f14';
  ctx.beginPath();
  ctx.ellipse(slothX-16, slothY, 6, 7, 0, 0, Math.PI*2);
  ctx.ellipse(slothX+16, slothY, 6, 7, 0, 0, Math.PI*2);
  ctx.fill();

  ctx.strokeStyle = '#0b0f14';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(slothX, slothY+16, 14, 0.1*Math.PI, 0.9*Math.PI);
  ctx.stroke();

  ctx.restore();

  // foreground UI hint (seed)
  ctx.fillStyle = 'rgba(242,247,255,0.50)';
  ctx.font = '600 14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  ctx.fillText(`seed ${sim.seed}${state.daily ? ' (daily)' : ''}`, 20, canvas.height-18);
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

let lastFrame = null;
function loop(ts){
  if(!sim.running) return;
  if(lastFrame == null) lastFrame = ts;
  const dt = Math.min(0.033, (ts - lastFrame)/1000);
  lastFrame = ts;

  step(dt);

  $('time').textContent = String(Math.ceil(sim.remaining));
  const still = clamp(sim.stillAcc / Math.max(0.0001, sim.t), 0, 1);
  $('still').textContent = String(Math.round(still*100));
  $('wobble').textContent = String((sim.wobbleAcc / Math.max(0.0001, sim.t)).toFixed(2));

  if(state.visuals !== 'off'){
    draw();
  } else {
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }

  if(sim.remaining <= 0){
    finish();
    return;
  }

  requestAnimationFrame(loop);
}

function finish(){
  sim.running = false;
  stopAudio();

  const still = clamp(sim.stillAcc / Math.max(0.0001, sim.t), 0, 1);
  const wob = sim.wobbleAcc / Math.max(0.0001, sim.t);
  const penalty = sim.interventions * 2.5;
  const score = clamp((still*100) - wob*18 - penalty, 0, 100);

  const result = { score, seed: sim.seed, interventions: sim.interventions, diff: state.diff, at: new Date().toISOString() };

  $('hint').textContent = `Result: ${score.toFixed(1)} • interventions ${sim.interventions} • seed ${sim.seed}. Stillness is a skill.`;
  $('btnShare').disabled = false;

  if(!state.best || score > state.best.score){
    state.best = result;
    save();
    setBestUI();
  }

  state.last = result;
  save();
}

// Share card
function drawShare(){
  const res = state.last || state.best;
  const canvas = $('shareCanvas');
  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  const g1 = c.createRadialGradient(w*0.18,h*0.25, 50, w*0.18,h*0.25, w*0.95);
  g1.addColorStop(0, 'rgba(123,211,137,0.30)');
  g1.addColorStop(1, 'rgba(11,15,20,1)');
  c.fillStyle = g1;
  c.fillRect(0,0,w,h);

  const g2 = c.createRadialGradient(w*0.86,h*0.1, 50, w*0.86,h*0.1, w*0.85);
  g2.addColorStop(0, 'rgba(106,167,255,0.24)');
  g2.addColorStop(1, 'rgba(11,15,20,0)');
  c.fillStyle = g2;
  c.fillRect(0,0,w,h);

  c.fillStyle = 'rgba(17,25,38,0.88)';
  roundRect(c, 70, 70, w-140, h-140, 26);
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.12)';
  c.lineWidth = 2;
  c.stroke();

  c.fillStyle = '#f2f7ff';
  c.font = '900 62px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  c.fillText('Sloth Branch Balance', 120, 160);

  c.fillStyle = 'rgba(242,247,255,0.78)';
  c.font = '650 28px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  c.fillText(`Stillness score`, 120, 218);

  c.fillStyle = 'rgba(123,211,137,0.98)';
  c.font = '900 64px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  c.fillText(`${res ? res.score.toFixed(1) : '—'}`, 120, 312);

  c.fillStyle = 'rgba(242,247,255,0.82)';
  c.font = '500 30px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  if(res){
    c.fillText(`Seed: ${res.seed} • Diff: ${res.diff} • Interventions: ${res.interventions}`, 120, 372);
  }

  c.fillStyle = 'rgba(106,167,255,0.94)';
  c.font = '600 24px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  c.fillText('owleggsbot.github.io/sloth-branch-balance', 120, h-120);

  c.save();
  c.translate(w-210, 130);
  c.scale(2.4, 2.4);
  drawSlothMark(c);
  c.restore();
}

function drawSlothMark(c){
  c.fillStyle = 'rgba(123,211,137,0.95)';
  c.beginPath();
  c.ellipse(30, 30, 24, 22, 0, 0, Math.PI*2);
  c.fill();

  c.fillStyle = 'rgba(11,15,20,0.9)';
  c.beginPath();
  c.ellipse(22, 28, 6, 7, 0, 0, Math.PI*2);
  c.ellipse(38, 28, 6, 7, 0, 0, Math.PI*2);
  c.fill();

  c.strokeStyle = 'rgba(11,15,20,0.9)';
  c.lineWidth = 3;
  c.beginPath();
  c.arc(30, 36, 9, 0.1*Math.PI, 0.9*Math.PI);
  c.stroke();
}

async function openShare(){
  drawShare();
  const canvas = $('shareCanvas');
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const url = URL.createObjectURL(blob);
  $('shareImg').src = url;
  const d = $('shareDialog');
  if(typeof d.showModal === 'function') d.showModal();
}

async function copyImage(){
  const canvas = $('shareCanvas');
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  try{
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    $('btnCopy').textContent = 'Copied';
    setTimeout(()=> $('btnCopy').textContent = 'Copy image', 1200);
  } catch {
    $('btnCopy').textContent = 'Unsupported';
    setTimeout(()=> $('btnCopy').textContent = 'Copy image', 1400);
  }
}

async function downloadImage(){
  const canvas = $('shareCanvas');
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sloth-branch-${Date.now()}.png`;
  a.click();
}

$('btnPlay').addEventListener('click', start);
$('btnShare').addEventListener('click', openShare);
$('btnCopy').addEventListener('click', copyImage);
$('btnDownload').addEventListener('click', downloadImage);

$('btnDaily').addEventListener('click', () => {
  state.daily = !state.daily;
  $('btnDaily').textContent = state.daily ? 'Daily seed' : 'Random seed';
  save();
  resetSim();
});

$('diff').addEventListener('change', () => { state.diff = $('diff').value; save(); });
$('visuals').addEventListener('change', () => { state.visuals = $('visuals').value; save(); });
$('sound').addEventListener('change', () => { state.sound = $('sound').checked; save(); if(!state.sound) stopAudio(); });

// initial
$('btnDaily').textContent = state.daily ? 'Daily seed' : 'Random seed';
$('diff').value = state.diff;
$('visuals').value = state.visuals;
$('sound').checked = !!state.sound;
setBestUI();
resetSim();

// reduced motion
if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
  state.visuals = 'reduced';
  save();
  $('visuals').value = 'reduced';
}
