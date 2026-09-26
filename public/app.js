/* ============================================================
   ParcelCheck — frontend logic (talks to the Express backend)
   ============================================================ */
'use strict';

const state = {
  photos: [],            // {id, name, dataUrl, tags:Set}
  audioBlob: null,
  audioURL: null,
  recording: false,
  server: null,          // {mode:'live'|'demo', pipeline:{...}}
  report: null,
  reportEngine: null,
  running: false
};
let mediaRecorder = null, mediaStream = null, recTimer = null, recStart = 0, speechRec = null, speechActive = false;

const DAMAGE_TAGS = ['Crushed', 'Torn', 'Wet', 'Punctured', 'Seal broken', 'Item damaged', 'Contents missing', 'Box intact'];

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');

function toast(msg, ms = 3400) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('toast-zone').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/* ---------------- server health ---------------- */
async function initServer() {
  try {
    state.server = await api('/api/health');
  } catch (err) {
    state.server = { mode: 'offline', pipeline: {} };
    toast('Backend unreachable — is the server running?');
  }
  refreshModeBadge();
}
function refreshModeBadge() {
  const badge = $('mode-badge');
  const live = state.server && state.server.mode === 'live';
  badge.classList.toggle('live', live);
  $('mode-badge-text').textContent = state.server ? (live ? 'LIVE API' : 'DEMO MODE') : 'OFFLINE';
  $('vision-model-label').textContent =
    live ? 'gemma4 image input (beta)'
    : (state.server && state.server.pipeline && state.server.pipeline.vision) || 'simulated image understanding';
  /* server info modal */
  const p = (state.server && state.server.pipeline) || {};
  $('server-sub').textContent = state.server
    ? `Backend is up and running in ${state.server.mode.toUpperCase()} mode.`
    : 'Backend unreachable.';
  $('server-pipeline-kv').innerHTML = [
    ['Vision', p.vision || '—'], ['Speech', p.speech || '—'], ['Report', p.report || '—']
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  updateSttNote();
}
function updateSttNote() {
  const live = state.server && state.server.mode === 'live';
  const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  $('stt-note').innerHTML = live
    ? 'Recorded audio is transcribed by <code>saaras:v3</code> on the server.'
    : (hasSR
      ? 'Demo mode: your browser&rsquo;s built-in speech recognition transcribes live as you speak (Chrome/Edge).'
      : 'Demo mode: no browser speech recognition available — type your description, or set SARVAM_API_KEY on the server for Saaras.');
}

$('btn-settings').onclick = () => { refreshModeBadge(); $('modal-back').classList.add('open'); };
$('modal-close').onclick = () => $('modal-back').classList.remove('open');
$('modal-back').addEventListener('click', e => { if (e.target === $('modal-back')) $('modal-back').classList.remove('open'); });

/* ---------------- photos ---------------- */
$('dropzone').onclick = () => $('photo-input').click();
$('dropzone').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('photo-input').click(); } };
$('photo-input').onchange = e => addPhotos([...e.target.files]);
['dragover', 'dragenter'].forEach(ev => $('dropzone').addEventListener(ev, e => { e.preventDefault(); $('dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => $('dropzone').addEventListener(ev, e => { e.preventDefault(); $('dropzone').classList.remove('drag'); }));
$('dropzone').addEventListener('drop', e => addPhotos([...e.dataTransfer.files]));

function addPhotos(files) {
  files.filter(f => f.type.startsWith('image/')).slice(0, 8).forEach(f => {
    const r = new FileReader();
    r.onload = () => {
      downscale(r.result, 1024).then(dataUrl => {
        state.photos.push({ id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), name: f.name, dataUrl, tags: new Set() });
        renderPhotos(); refreshRunState();
      });
    };
    r.readAsDataURL(f);
  });
}
function downscale(dataUrl, max) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      if (sc === 1) { res(dataUrl); return; }
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', .85));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}
function renderPhotos() {
  const strip = $('photo-strip');
  strip.innerHTML = '';
  state.photos.forEach(p => {
    const d = document.createElement('div');
    d.className = 'photo-card';
    d.innerHTML = `<img src="${p.dataUrl}" alt="${esc(p.name)}">
      <div class="pname">${esc(p.name)}</div>
      <div class="tag-row">${DAMAGE_TAGS.map(t =>
      `<span class="tag-chip ${p.tags.has(t) ? 'on' : ''}" data-tag="${t}">${t}</span>`).join('')}</div>
      <button class="photo-del" title="remove" aria-label="remove photo">✕</button>`;
    d.querySelectorAll('.tag-chip').forEach(ch => ch.onclick = () => {
      p.tags.has(ch.dataset.tag) ? p.tags.delete(ch.dataset.tag) : p.tags.add(ch.dataset.tag);
      ch.classList.toggle('on'); refreshRunState();
    });
    d.querySelector('.photo-del').onclick = () => {
      state.photos = state.photos.filter(x => x !== p); renderPhotos(); refreshRunState();
    };
    strip.appendChild(d);
  });
}
function refreshRunState() {
  const has = state.photos.length > 0 || $('voice-text').value.trim().length > 10 || state.audioBlob;
  $('btn-run').disabled = !has || state.running;
  $('action-hint').textContent = has
    ? (state.photos.length ? `${state.photos.length} photo${state.photos.length > 1 ? 's' : ''} · ` : '')
    + (state.audioBlob ? 'voice note · ' : '')
    + ($('voice-text').value.trim() ? 'description · ' : '')
    + 'ready when you are.'
    : 'Add at least one photo, voice note or typed description to run the pipeline.';
}
$('voice-text').addEventListener('input', refreshRunState);

/* ---------------- voice recording ---------------- */
$('rec-btn').onclick = toggleRecording;
async function toggleRecording() {
  if (state.recording) { stopRecording(); return; }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast('Microphone unavailable — you can type your description instead.');
    $('voice-text').focus();
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  mediaRecorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mediaRecorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  mediaRecorder.onstop = () => {
    state.audioBlob = new Blob(chunks, { type: mime || 'audio/webm' });
    state.audioURL = URL.createObjectURL(state.audioBlob);
    $('audio-play').src = state.audioURL;
    $('audio-holder').style.display = 'block';
    mediaStream.getTracks().forEach(t => t.stop());
    refreshRunState();
  };
  mediaRecorder.start();
  state.recording = true;
  $('rec-btn').classList.add('recording');
  $('rec-icon').innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>';
  $('rec-state').textContent = 'Recording… tap to stop';
  recStart = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $('rec-timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 250);
  /* demo mode: live browser transcription in parallel (server has no key) */
  const live = state.server && state.server.mode === 'live';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!live && SR) {
    try {
      speechRec = new SR();
      const lang = $('voice-lang').value;
      if (lang !== 'auto') speechRec.lang = lang;
      speechRec.continuous = true; speechRec.interimResults = true;
      speechActive = true;
      let base = '';
      speechRec.onresult = ev => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript;
          if (ev.results[i].isFinal) base += t + ' ';
          else interim += t;
        }
        $('voice-text').value = (base + interim).replace(/\s+/g, ' ').trimStart();
        refreshRunState();
      };
      speechRec.onend = () => { if (speechActive) { try { speechRec.start(); } catch (e) { } } };
      speechRec.start();
    } catch (e) { speechRec = null; }
  }
}
function stopRecording() {
  state.recording = false;
  clearInterval(recTimer);
  try { mediaRecorder && mediaRecorder.state !== 'inactive' && mediaRecorder.stop(); } catch (e) { }
  $('rec-btn').classList.remove('recording');
  $('rec-icon').innerHTML = '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><path d="M12 19v4"/><path d="M8 23h8"/>';
  $('rec-state').textContent = 'Recorded — re-tap to record again';
  speechActive = false;
  try { speechRec && speechRec.stop(); } catch (e) { }
  speechRec = null;
}

/* ---------------- pipeline ---------------- */
function setStage(name, s) {
  const el = $('stage-' + name), st = $('st-' + name);
  el.classList.remove('running', 'done');
  if (s === 'running') { el.classList.add('running'); st.innerHTML = '<span class="sdot"></span>RUNNING'; }
  if (s === 'done') { el.classList.add('done'); st.innerHTML = '<span class="sdot"></span>DONE'; }
  if (s === 'idle') { st.innerHTML = '<span class="sdot"></span>IDLE'; }
  if (s === 'skipped') { st.innerHTML = '<span class="sdot"></span>SKIPPED'; }
}
function stageOut(name, text, isErr) {
  $('out-' + name).innerHTML = isErr ? `<span class="err">${esc(text)}</span>` : esc(text);
}

async function runPipeline() {
  if (state.running) return;
  state.running = true; refreshRunState();
  $('pipeline-section').style.display = 'block';
  $('report-section').style.display = 'none';
  setStep(2);
  ['vision', 'saaras', 'llm'].forEach(s => { setStage(s, 'idle'); stageOut(s, 'Waiting for evidence…'); });
  $('pipeline-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

  /* ---- stage 1 : vision (server) ---- */
  setStage('vision', 'running');
  let visionFindings = null, visionMode = 'demo';
  if (state.photos.length === 0) {
    setStage('vision', 'skipped'); stageOut('vision', 'No photos attached — skipped.');
  } else {
    try {
      const r = await api('/api/analyze-photos', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photos: state.photos.map(p => ({ name: p.name, dataUrl: p.dataUrl, tags: [...p.tags] })) })
      });
      visionFindings = r.findings; visionMode = r.mode;
      stageOut('vision', `[${r.mode}] ` + visionFindings.map((f, i) => `photo ${i + 1}: ${f}`).join('\n'));
      setStage('vision', 'done');
    } catch (err) {
      stageOut('vision', `Server vision call failed (${err.message})`, true);
      visionFindings = state.photos.map(p => p.tags.size ? `shows ${[...p.tags].join(', ').toLowerCase()}` : 'no tags set');
      setStage('vision', 'done');
    }
  }

  /* ---- stage 2 : saaras (server) ---- */
  setStage('saaras', 'running');
  let transcript = $('voice-text').value.trim();
  let voiceSource = 'none';
  if (state.audioBlob) {
    try {
      const lang = $('voice-lang').value;
      const r = await api('/api/stt?language=' + encodeURIComponent(lang), {
        method: 'POST', headers: { 'Content-Type': state.audioBlob.type || 'audio/webm' }, body: state.audioBlob
      });
      if (r.mode === 'live' && r.transcript) {
        transcript = r.transcript; voiceSource = 'voice note (saaras:v3)';
        stageOut('saaras', `[saaras:v3] ${transcript}`);
      } else {
        stageOut('saaras', transcript ? transcript + '\n[local browser transcription]' : '[demo] (no speech captured — nothing typed)');
        if (transcript) voiceSource = 'voice note (browser)';
      }
      setStage('saaras', 'done');
    } catch (err) {
      stageOut('saaras', `Saaras call failed (${err.message}) — using typed/local text instead.`, true);
      if (transcript) voiceSource = 'voice note (fallback text)';
      setStage('saaras', 'done');
    }
  } else {
    await sleep(350);
    if (transcript) { voiceSource = 'typed'; stageOut('saaras', transcript + '\n[typed description — no audio]'); setStage('saaras', 'done'); }
    else { stageOut('saaras', '(no voice note, no typed text)'); setStage('saaras', 'skipped'); }
  }

  /* ---- stage 3 : sarvam-105b (server) ---- */
  setStage('llm', 'running');
  const inputs = collectInputs(transcript, visionFindings, voiceSource);
  let report;
  try {
    const r = await api('/api/generate-report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inputs)
    });
    report = r.report; state.reportEngine = r.engine + (r.error ? ` (fallback: ${r.error})` : '');
    stageOut('llm', `[${r.engine}] structured claim assembled (${report.damage.types.length} damage type(s), severity: ${report.damage.severity})`);
  } catch (err) {
    toast('Report generation failed: ' + err.message);
    setStage('llm', 'skipped');
    state.running = false; refreshRunState();
    return;
  }
  setStage('llm', 'done');

  state.report = report;
  renderReport(report);
  $('report-section').style.display = 'block';   /* bugfix: was hidden, never shown */
  setStep(3);
  state.running = false; refreshRunState();
  $('report-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Damage report ready — review, then save the claim.');
}

/* ---------------- inputs ---------------- */
function collectInputs(transcript, visionFindings, voiceSource) {
  return {
    transcript,
    vision: visionFindings || [],
    voiceSource,
    photos: state.photos.map(p => ({ name: p.name, tags: [...p.tags] })),
    order: {
      order_id: $('f-order').value.trim(),
      item: $('f-item').value.trim(),
      value_inr: Number($('f-value').value) || null,
      marketplace: $('f-market').value,
      courier: $('f-courier').value,
      delivered_on: $('f-date').value,
      customer: $('f-name').value.trim(),
      contact: $('f-contact').value.trim()
    }
  };
}

/* ---------------- report rendering ---------------- */
const SEV_CLASS = { minor: 'sev-minor', moderate: 'sev-moderate', severe: 'sev-severe' };
function renderReport(rep) {
  $('rep-badges').innerHTML = `
    <span class="sev-badge ${SEV_CLASS[rep.damage.severity] || 'sev-minor'}"><span class="sdot"></span>${esc(rep.damage.severity || 'minor').toUpperCase()} DAMAGE</span>
    <span class="mode-badge">${esc(rep.recommended_action || '')}</span>
    <span class="mode-badge">${esc(rep.claim.claim_id)}</span>`;
  $('rep-summary').textContent = rep.damage.summary || '—';
  const kv = $('rep-kv');
  const o = rep.order || {};
  kv.innerHTML = [
    ['Order ID', o.order_id || '—'], ['Item', o.item || '—'],
    ['Value', o.value_inr ? inr(o.value_inr) : '—'], ['Marketplace', o.marketplace || '—'],
    ['Courier', o.courier || '—'], ['Delivered', o.delivered_on || '—'],
    ['Damage types', (rep.damage.types || []).join(', ') || '—'],
    ['Photos attached', String((rep.evidence && rep.evidence.photos || []).length)],
    ['Voice note', (rep.evidence && rep.evidence.voice && rep.evidence.voice.transcript) ? 'yes' : 'no']
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('rep-json').textContent = JSON.stringify(rep, null, 2);
  $('rep-letter').textContent = buildLetter(rep);
}
function buildLetter(rep) {
  const o = rep.order || {};
  const name = o.customer || '[your name]';
  const contact = o.contact || '[email / phone]';
  const item = o.item || 'my order';
  const oid = o.order_id || '[order id]';
  const photos = (rep.evidence && rep.evidence.photos || []).length;
  return `Subject: Damaged parcel received — Order ${oid} (${item})

Dear ${o.marketplace || 'Seller'} Support,

I am writing to report that my order ${oid} (${item}${o.value_inr ? `, value ${inr(o.value_inr)}` : ""}) arrived in damaged condition${o.delivered_on ? ` on ${o.delivered_on}` : ''}${o.courier ? ` via ${o.courier}` : ''}.

Damage observed: ${(rep.damage.types || []).join(', ') || 'as shown in the attached photos'}.

Summary: ${rep.damage.summary || ''}

${(rep.evidence && rep.evidence.voice && rep.evidence.voice.transcript) ? `In my own words: "${rep.evidence.voice.transcript.trim()}"\n` : ''}${photos ? `I have attached ${photos} photo${photos > 1 ? 's' : ''} of the packaging and damage as evidence.\n` : ''}
Requested resolution: ${rep.recommended_action || 'appropriate compensation'}.

I request that this be processed at the earliest. Please let me know if any further information is required.

Regards,
${name}
${contact}
Claim reference: ${rep.claim.claim_id}
Generated with ParcelCheck on ${new Date().toLocaleDateString('en-IN')}`;
}

/* ---------------- claims: save & list ---------------- */
$('btn-save-claim').onclick = async () => {
  if (!state.report) return;
  /* pull the latest edited summary into the report before saving */
  state.report.damage.summary = $('rep-summary').innerText.trim();
  try {
    const saved = await api('/api/claims', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.report)
    });
    state.report = saved;
    renderReport(saved);
    toast(`Claim ${saved.claim.claim_id} saved to the server.`);
    loadClaims();
  } catch (err) {
    toast('Save failed: ' + err.message);
  }
};

async function loadClaims() {
  try {
    const list = await api('/api/claims');
    const el = $('claims-list');
    if (!list.length) {
      el.innerHTML = '<div class="empty-note">No claims saved yet — generate a report and hit “Save claim”.</div>';
      return;
    }
    el.innerHTML = list.map(c => `
      <div class="claim-row" data-id="${esc(c.claim_id)}">
        <span class="cid">${esc(c.claim_id)}</span>
        <span class="citem">${esc(c.item || c.order_id || 'untitled claim')}</span>
        <span class="cmeta">${esc(c.severity || '')}${c.recommended_action ? ' · ' + esc(c.recommended_action) : ''}${c.saved_at ? ' · ' + new Date(c.saved_at).toLocaleString('en-IN') : ''}</span>
        <span class="status-pill ${c.status === 'draft' ? '' : c.status}">${esc(c.status || 'draft')}</span>
        <span class="cact">
          <button data-act="open">open</button>
          ${c.status === 'draft' ? '<button data-act="submitted">mark submitted</button>' : ''}
          ${c.status === 'submitted' ? '<button data-act="resolved">mark resolved</button>' : ''}
        </span>
      </div>`).join('');
    el.querySelectorAll('.claim-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelectorAll('button').forEach(b => {
        b.onclick = async () => {
          if (b.dataset.act === 'open') {
            try {
              state.report = await api('/api/claims/' + encodeURIComponent(id));
              renderReport(state.report);
              $('report-section').scrollIntoView({ behavior: 'smooth' });
            } catch (err) { toast('Could not load claim: ' + err.message); }
          } else {
            try {
              await api('/api/claims/' + encodeURIComponent(id), {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.act })
              });
              loadClaims();
            } catch (err) { toast('Update failed: ' + err.message); }
          }
        };
      });
    });
  } catch (err) {
    $('claims-list').innerHTML = '<div class="empty-note">Could not reach the claims store.</div>';
  }
}

/* ---------------- copy / download ---------------- */
document.querySelectorAll('[data-copy]').forEach(b => {
  b.onclick = async () => {
    const what = b.dataset.copy;
    const text = what === 'summary' ? $('rep-summary').innerText
      : what === 'json' ? JSON.stringify(state.report, null, 2)
        : $('rep-letter').textContent;
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); toast('Copied to clipboard.');
    }
  };
});
$('btn-download').onclick = () => {
  if (!state.report) return;
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `parcelcheck-claim-${state.report.claim.claim_id}.json`;
  a.click(); URL.revokeObjectURL(a.href);
};

/* ---------------- stepper ---------------- */
function setStep(n) {
  [1, 2, 3].forEach(i => {
    const el = $('step-ind-' + i);
    el.classList.remove('active', 'done');
    if (i < n) el.classList.add('done');
    if (i === n) el.classList.add('active');
  });
}

/* ---------------- sample data ---------------- */
$('btn-sample').onclick = () => {
  if (state.recording) stopRecording();
  $('f-order').value = 'OD429118735K';
  $('f-item').value = 'Borosil Chopper 400ml (glass bowl)';
  $('f-value').value = '1299';
  $('f-market').value = 'Flipkart';
  $('f-courier').value = 'Ecom Express';
  $('f-date').value = '2026-09-24';
  $('f-name').value = 'Hitesh Reddy';
  $('f-contact').value = 'hiteshreddy7777@gmail.com';
  $('voice-text').value = 'The box came fully crushed on one corner and when I opened it the glass bowl of the chopper was broken into pieces. There were glass shards inside the packaging. The outer tape was also torn and resealed.';
  const svg1 = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="#d6cfc7"/><rect x="60" y="110" width="480" height="300" rx="8" fill="#b99371"/><rect x="60" y="110" width="480" height="60" rx="8" fill="#a07c5b"/><path d="M430 110 L470 410 L380 410 L350 110 Z" fill="#8c6a4d" opacity=".55"/><text x="300" y="260" font-family="serif" font-size="34" fill="#5c4632" text-anchor="middle" transform="rotate(-4 300 260)">FRAGILE — CRUSHED CORNER</text><rect x="140" y="380" width="320" height="10" fill="#5c4632" opacity=".4"/></svg>`);
  const svg2 = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="#e3ddd6"/><circle cx="210" cy="200" r="46" fill="none" stroke="#8c6a4d" stroke-width="5"/><path d="M240 230 L300 300 M185 170 L150 130 M255 155 L300 110 M175 235 L130 280" stroke="#8c6a4d" stroke-width="5"/><path d="M150 130 l12 6 m-6 -12 l0 12 M300 110 l-12 8 m10 -14 l-6 12 M130 280 l14 2 m-8 -10 l4 12" stroke="#8c6a4d" stroke-width="4"/><text x="430" y="330" font-family="serif" font-size="26" fill="#8c6a4d" text-anchor="middle">broken glass bowl</text></svg>`);
  state.photos = [
    { id: 's1', name: 'parcel-crushed.jpg', dataUrl: svg1, tags: new Set(['Crushed', 'Torn', 'Item damaged']) },
    { id: 's2', name: 'bowl-broken.jpg', dataUrl: svg2, tags: new Set(['Item damaged']) }
  ];
  renderPhotos();
  refreshRunState();
  toast('Sample claim loaded — hit "Generate damage report" to run the pipeline.');
};

/* ---------------- init ---------------- */
$('btn-run').onclick = runPipeline;
setStep(1);
$('report-section').style.display = 'none';   /* start hidden until a report exists */
initServer().then(loadClaims);
