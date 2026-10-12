// scripts/build.js
// Usage: node scripts/build.js --src n1.html --out publish/index.html [--next next.js]
// Reads n1.html, inlines next.js if present, compresses (lz-string->base64),
// splits into randomized chunk lengths, applies small per-chunk transforms,
// and emits a self-contained index.html that will reconstruct the page client-side
// only after a stronger human interaction check (higher thresholds, click confirmation,
// drag gesture, and a CSS-rendered passphrase check). Intended to run in GitHub Actions.

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');

function usage() {
  console.error('Usage: node scripts/build.js --src n1.html --out publish/index.html [--next next.js]');
  process.exit(2);
}

const argv = require('minimist')(process.argv.slice(2));
if (!argv.src || !argv.out) usage();

const srcPath = argv.src;
const outPath = argv.out;
const nextPath = argv.next;

if (!fs.existsSync(srcPath)) {
  console.error('Source file not found:', srcPath);
  process.exit(1);
}

let html = fs.readFileSync(srcPath, 'utf8');

// Inline next.js if requested and file exists
if (nextPath && fs.existsSync(nextPath)) {
  try {
    const nextText = fs.readFileSync(nextPath, 'utf8');
    html = html.replace(/<script\s+[^>]*src=["']next\.js["'][^>]*>\s*<\/script>/i, '<script>' + nextText + '</script>');
  } catch (e) {
    console.warn('Could not inline next.js:', e);
  }
}

// compress to base64 using lz-string
const compressedB64 = LZString.compressToBase64(html);

// per-build randomness
function randBytes(n) {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i=0;i<n;i++) s += chars.charAt(Math.floor(Math.random()*chars.length));
  return s;
}
const passphrase = randBytes(6); // will be embedded into CSS as generated content
const pieceLen = 80 + Math.floor(Math.random() * 160); // 80..239

// split into pieces
function splitIntoPieces(s, pieceLen) {
  const out = [];
  for (let i = 0; i < s.length; i += pieceLen) out.push(s.slice(i, i + pieceLen));
  return out;
}
let pieces = splitIntoPieces(compressedB64, pieceLen);

// apply light piece-level transforms (rotate + reverse) to frustrate static regex
pieces = pieces.map(p => {
  const rot = (p.length % 11); // use 11 to vary more
  const transformed = p.split('').map(c => String.fromCharCode((c.charCodeAt(0) + rot) & 0xFF)).reverse().join('');
  return transformed;
});

// Build index.html with stronger thresholds and micro-CAPTCHA + drag + CSS passphrase
const config = {
  requiredSamples: 6,            // must collect at least this many interaction samples
  minTotalDistance: 120,         // pixels of movement across samples required
  minTimingVariance: 40,         // ms variance threshold for intervals
  requireClickConfirm: true,     // require a click on micro-CAPTCHA
  requireDrag: true,             // require a drag gesture
  minDragDistance: 50,           // px distance threshold for drag
  passphrase: passphrase         // CSS-derived passphrase
};

const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>Loading…</title>
<style>
  /* A hidden element with a CSS ::before that contains the passphrase string.
     This requires the browser to render CSS for the client to read the passphrase.
     Some simplistic scrapers may not expose pseudo-element content via computed style. */
  #css-pass::before { content: "${passphrase}"; display:none; }
  /* Micro-CAPTCHA styles */
  #human-overlay { position: fixed; inset: 0; display:flex; align-items:center; justify-content:center; background: rgba(255,255,255,0.98); z-index:2147483647; }
  #human-box { background: white; border-radius:8px; padding:20px; box-shadow:0 6px 24px rgba(0,0,0,0.16); text-align:center; max-width:90%; }
  #confirm-btn { display:inline-block; padding:10px 16px; background:#0b61ff; color:white; border-radius:6px; border:none; cursor:pointer; font-weight:600; }
  #drag-hint { margin-top:10px; font-size:13px; color:#444; }
</style>
<div id="css-pass" aria-hidden="true"></div>
<script>
// Embedded minimal LZString decompressFromBase64 (adapted)
var LZString = (function(){
  function decompressFromBase64(input) {
    if (input == null) return '';
    try {
      var str = atob(input);
      var out = '';
      for (var i=0;i<str.length;i++) {
        out += '%' + ('00' + str.charCodeAt(i).toString(16)).slice(-2);
      }
      return decodeURIComponent(out);
    } catch (e) { return null; }
  }
  return {decompressFromBase64:decompressFromBase64};
})();

var pieces = ${JSON.stringify(pieces)};
var config = ${JSON.stringify(config)};

function reassemblePieces() {
  var out = '';
  for (var i=0;i<pieces.length;i++) {
    var p = pieces[i];
    var rot = (p.length % 11);
    var chars = [];
    for (var j=0;j<p.length;j++) {
      var code = (p.charCodeAt(j) - rot) & 0xFF;
      chars.push(String.fromCharCode(code));
    }
    out += chars.reverse().join('');
  }
  return out; // base64 compressed payload
}

// Interaction sampling
var interactions = [];
var maxSamples = 16;
var sampleTimeout = 1500; // ms to wait initially
var sampling = true;
var startTime = Date.now();
var dragStart = null;
var gotClickConfirm = false;
var gotDrag = false;

function recordInteraction(evt) {
  if (!sampling) return;
  try {
    var now = Date.now();
    var t = now - startTime;
    var e = {t: t};
    if (evt.touches && evt.touches[0]) {
      e.x = Math.round(evt.touches[0].clientX);
      e.y = Math.round(evt.touches[0].clientY);
    } else if (typeof evt.clientX === 'number') {
      e.x = Math.round(evt.clientX);
      e.y = Math.round(evt.clientY);
    } else if (evt.key) {
      e.k = evt.key;
    }
    interactions.push(e);
    if (interactions.length >= maxSamples) finishSampling();
  } catch (e) {}
}

function finishSampling() {
  if (!sampling) return;
  sampling = false;
  window.removeEventListener('mousemove', recordInteraction);
  window.removeEventListener('touchstart', recordInteraction);
  window.removeEventListener('keydown', recordInteraction);
  attemptReconstruct();
}

// micro-CAPTCHA overlay: click to confirm
function showHumanOverlay() {
  var overlay = document.createElement('div');
  overlay.id = 'human-overlay';
  overlay.innerHTML = '<div id="human-box">\n  <h2 style="margin:0 0 8px 0">Just one more step</h2>\n  <p style="margin:0 0 12px 0">Click the button below to confirm you are human and then perform a short drag gesture.</p>\n  <button id="confirm-btn">I am human</button>\n  <div id="drag-hint">Then press and drag anywhere on the page for at least ' + config.minDragDistance + ' pixels.</div>\n</div>';
  document.documentElement.appendChild(overlay);
  var btn = document.getElementById('confirm-btn');
  btn.addEventListener('click', function(){ gotClickConfirm = true; overlay.remove(); });
}

// Drag handlers
function onPointerDown(e) {
  dragStart = {x: e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 0, y: e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY) || 0};
}
function onPointerUp(e) {
  if (!dragStart) return;
  var x = e.clientX || (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientX) || 0;
  var y = e.clientY || (e.changedTouches && e.changedTouches[0] && e.changedTouches[0].clientY) || 0;
  var dx = x - dragStart.x;
  var dy = y - dragStart.y;
  var dist = Math.sqrt(dx*dx + dy*dy);
  if (dist >= config.minDragDistance) gotDrag = true;
  dragStart = null;
}

window.addEventListener('mousedown', onPointerDown);
window.addEventListener('touchstart', onPointerDown, {passive:true});
window.addEventListener('mouseup', onPointerUp);
window.addEventListener('touchend', onPointerUp);

// initial sampling listeners
window.addEventListener('mousemove', recordInteraction);
window.addEventListener('touchstart', recordInteraction, {passive:true});
window.addEventListener('keydown', recordInteraction);

// fallback prompt after timeout
setTimeout(function(){
  if (sampling) {
    if (interactions.length > 0) {
      finishSampling();
    } else {
      // if no interaction yet, show micro-CAPTCHA overlay to require explicit click
      showHumanOverlay();
      // resume sampling on first interaction
      sampling = true;
      var resume = function(evt){ interactions.push({t:Date.now()-startTime, x:evt.clientX||0, y:evt.clientY||0}); var ov = document.getElementById('human-overlay'); if (ov) ov.remove(); finishSampling(); };
      window.addEventListener('mousemove', resume, {once:true});
      window.addEventListener('touchstart', resume, {once:true});
      window.addEventListener('keydown', resume, {once:true});
    }
  }
}, sampleTimeout);

// derive a short proof hash (SHA-256) from the interactions + UA + css passphrase
async function makeProof() {
  try {
    var s = '';
    for (var i=0;i<interactions.length;i++) {
      var v = interactions[i];
      s += (v.x||0)+','+(v.y||0)+','+(v.t||0)+','+(v.k||'')+';';
    }
    // read passphrase from computed style of pseudo-element
    var pass = '';
    try {
      var el = document.getElementById('css-pass');
      var cs = window.getComputedStyle(el, '::before');
      pass = cs && cs.content ? cs.content.replace(/^"|"$/g,'') : '';
    } catch(e) { pass = ''; }
    s += navigator.userAgent + '|' + screen.width + 'x' + screen.height + '|' + pass + '|' + Math.round(performance.now());
    var enc = new TextEncoder().encode(s);
    var digest = await crypto.subtle.digest('SHA-256', enc);
    var arr = Array.from(new Uint8Array(digest));
    var hex = arr.map(b => ('00'+b.toString(16)).slice(-2)).join('');
    return {hex:hex, count: interactions.length};
  } catch (e) { return {hex:null, count: interactions.length}; }
}

function computeStats() {
  if (!interactions.length) return {count:0, totalDist:0, variance:0};
  let totalDist = 0;
  let last = null;
  let times = [];
  for (let i=0;i<interactions.length;i++) {
    const e = interactions[i];
    times.push(e.t);
    if (last && typeof e.x === 'number' && typeof e.y === 'number' && typeof last.x === 'number' && typeof last.y === 'number') {
      const dx = e.x - last.x; const dy = e.y - last.y; totalDist += Math.sqrt(dx*dx + dy*dy);
    }
    last = e;
  }
  let intervals = [];
  for (let i=1;i<times.length;i++) intervals.push(times[i]-times[i-1]);
  let mean = intervals.length ? intervals.reduce((a,b)=>a+b,0)/intervals.length : 0;
  let variance = intervals.length ? intervals.reduce((a,b)=>a + Math.pow(b-mean,2),0)/intervals.length : 0;
  return {count: interactions.length, totalDist: Math.round(totalDist), variance: Math.round(variance)};
}

// final reconstruction rule: check thresholds, click confirm and drag if required, and passphrase match
async function attemptReconstruct() {
  // Ensure micro-confirmation if configured
  if (config.requireClickConfirm && !gotClickConfirm) {
    showHumanOverlay();
    // wait for the click to set gotClickConfirm; user will then do a drag and we continue
    return;
  }

  // Evaluate stats
  const stats = computeStats();
  if (stats.count < config.requiredSamples || stats.totalDist < config.minTotalDistance || stats.variance < config.minTimingVariance) {
    document.open();
    document.write('<meta name="robots" content="noindex,nofollow">');
    document.write('<h2>Human interaction required</h2><p>Please interact with this page (move mouse, click and drag) to view the content.</p>');
    document.close();
    return;
  }

  if (config.requireDrag && !gotDrag) {
    // show small instruction overlay for drag
    var d = document.createElement('div');
    d.id = 'human-overlay';
    d.innerHTML = '<div id="human-box"><h3>Drag required</h3><p>Please press and drag your mouse (or touch and drag) across the page for at least ' + config.minDragDistance + ' pixels.</p></div>';
    document.documentElement.appendChild(d);
    // wait until gotDrag becomes true by the drag handlers; poll a bit
    var poll = setInterval(function(){ if (gotDrag) { clearInterval(poll); d.remove(); attemptReconstruct(); } }, 200);
    return;
  }

  // verify passphrase from CSS
  var pass = '';
  try {
    var el = document.getElementById('css-pass');
    var cs = window.getComputedStyle(el, '::before');
    pass = cs && cs.content ? cs.content.replace(/^"|"$/g,'') : '';
  } catch(e) { pass = ''; }
  if (pass !== config.passphrase) {
    // suspicious environment: pseudo-element content missing
    document.open();
    document.write('<meta name="robots" content="noindex,nofollow">');
    document.write('<h2>Rendering required</h2><p>Your browser must render CSS for this page. Please try a different browser.</p>');
    document.close();
    return;
  }

  // local proof compute (optional) - derive a small key from hash to mix with payload (not used here)
  const assembled = reassemblePieces();
  try {
    const html = LZString.decompressFromBase64(assembled);
    if (html == null) throw new Error('decompress failed');
    document.open();
    document.write(html);
    document.close();
  } catch (e) {
    console.error('Reconstruction failed:', e);
    document.open();
    document.write('<meta name="robots" content="noindex,nofollow">');
    document.write('<h2>Page failed to load</h2><p>There was an error reconstructing the page.</p>');
    document.close();
  }
}

// attempt auto-reconstruct when sampling finishes or when user confirms overlay
window.addEventListener('click', function(){ if (!sampling) attemptReconstruct(); });

</script>
<noscript>
<meta name="robots" content="noindex,nofollow">
<p>JavaScript is required to view this page.</p>
</noscript>
`;

const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, indexHtml, 'utf8');
console.log('Wrote', outPath);
console.log('Passphrase (for debugging):', passphrase);
