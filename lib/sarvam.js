/**
 * Sarvam AI client for ParcelCheck.
 *
 * Live mode: talks to https://api.sarvam.ai
 *   - Saaras v3  -> POST /speech-to-text        (multipart)
 *   - gemma4     -> POST /v2/chat/completions   (image input, beta)
 *   - sarvam-105b-> POST /v1/chat/completions   (JSON response format)
 *
 * Demo mode (no API key): deterministic local heuristics that mimic the
 * pipeline so the whole app works with zero setup.
 *
 * The API key is read from the environment — it is never hardcoded and
 * never sent to the browser.
 */
'use strict';

const API_BASE = 'https://api.sarvam.ai';

const DAMAGE_TAGS = ['Crushed', 'Torn', 'Wet', 'Punctured', 'Seal broken', 'Item damaged', 'Contents missing', 'Box intact'];

const SEV_WEIGHT = { 'Item damaged': 3, 'Crushed': 2, 'Punctured': 2, 'Wet': 2, 'Contents missing': 2, 'Torn': 1, 'Seal broken': 1, 'Box intact': -2 };

const KEYWORD_HITS = [
  [/broke|broken|shatter|crack|leak|spill|smash/i, 'reported breakage'],
  [/crush|dent|flatten/i, 'Crushed'],
  [/wet|water|rain|soak/i, 'Wet'],
  [/torn|rip/i, 'Torn'],
  [/missing|empty|gone/i, 'Contents missing']
];

const hasKey = () => !!process.env.SARVAM_API_KEY;

/* ------------------------------------------------------------------ */
/*  low-level helpers                                                  */
/* ------------------------------------------------------------------ */

async function apiFetch(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': process.env.SARVAM_API_KEY
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(shortErr(res.status, text));
  }
  return res.json();
}

function shortErr(status, text) {
  try {
    const j = JSON.parse(text);
    const m = j.message || j.detail || (j.error && j.error.message) || text;
    return `HTTP ${status}: ${String(m).slice(0, 160)}`;
  } catch {
    return `HTTP ${status}` + (text ? `: ${text.slice(0, 140)}` : '');
  }
}

/* ------------------------------------------------------------------ */
/*  Saaras v3 — speech to text                                          */
/* ------------------------------------------------------------------ */

async function transcribeAudio(audioBuffer, mimetype, languageCode) {
  const form = new FormData();
  const ext = (mimetype || 'audio/webm').includes('ogg') ? 'ogg'
    : (mimetype || '').includes('mp4') ? 'm4a' : 'webm';
  form.append('file', new Blob([audioBuffer], { type: mimetype || 'audio/webm' }), `voice-note.${ext}`);
  form.append('model', 'saaras:v3');
  form.append('mode', 'transcribe');
  if (languageCode && languageCode !== 'auto') form.append('language_code', languageCode);

  const res = await fetch(API_BASE + '/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
    body: form
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(shortErr(res.status, text));
  }
  const j = await res.json();
  return j.transcript || j.text || '';
}

/* ------------------------------------------------------------------ */
/*  Vision — package photo analysis (gemma4 image input, beta)          */
/* ------------------------------------------------------------------ */

async function analyzePhoto(dataUrl) {
  const body = {
    model: 'gemma4',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'This is a photo of a delivered parcel. Briefly describe the packaging condition and any visible damage in 1-2 sentences. Mention box state, labels, and whether contents look affected.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }]
  };
  const r = await apiFetch('/v2/chat/completions', body);
  const out = (r.choices && r.choices[0] && r.choices[0].message.content || '').trim();
  if (!out) throw new Error('empty vision response');
  return out;
}

/* ------------------------------------------------------------------ */
/*  Sarvam-105B — structure the evidence into a claim                   */
/* ------------------------------------------------------------------ */

async function generateReportLive(inputs) {
  const schemaHint = '{"claim":{"claim_id":"","created_at":"","status":"draft"},"order":{"order_id":"","item":"","value_inr":0,"marketplace":"","courier":"","delivered_on":"","customer":"","contact":""},"damage":{"types":[""],"severity":"minor|moderate|severe","summary":""},"evidence":{"photos":[],"voice":{"transcript":"","source":""}},"recommended_action":"refund|replacement|repair or partial refund"}';
  const prompt =
`You are ParcelCheck, an assistant that converts damaged-parcel evidence into a structured damage claim for an Indian e-commerce customer.
Given the evidence below, output ONLY a JSON object matching this schema:
${schemaHint}

Rules:
- damage.types: short lowercase damage descriptors (e.g. "crushed box", "torn packaging", "item damaged", "wet", "punctured", "contents missing").
- damage.severity: one of minor / moderate / severe, judged from the evidence.
- damage.summary: 3-5 sentence plain-English claim narrative combining photos, voice and order details.
- recommended_action: the most sensible resolution for the customer.

EVIDENCE:
Per-photo visual analysis: ${JSON.stringify(inputs.vision)}
Per-photo user tags: ${JSON.stringify(inputs.photos.map(p => p.tags))}
Voice/transcript/description: ${inputs.transcript}
Order details: ${JSON.stringify(inputs.order)}`;

  const body = {
    model: 'sarvam-105b',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You output only valid JSON.' },
      { role: 'user', content: prompt }
    ]
  };
  const r = await apiFetch('/v1/chat/completions', body);
  let txt = (r.choices && r.choices[0] && r.choices[0].message.content || '').trim();
  txt = txt.replace(/^```(json)?\s*/, '').replace(/```\s*$/, '');
  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error('model returned non-JSON output'); }
  return normalizeReport(j, inputs);
}

function normalizeReport(j, inputs) {
  j.claim = j.claim || {};
  j.claim.claim_id = j.claim.claim_id || 'PC-' + Date.now().toString(36).toUpperCase();
  j.claim.created_at = j.claim.created_at || new Date().toISOString();
  j.claim.status = j.claim.status || 'draft';
  j.order = Object.assign({}, inputs.order, j.order || {});
  j.damage = j.damage || { types: [], severity: 'minor', summary: '' };
  if (!Array.isArray(j.damage.types)) j.damage.types = j.damage.types ? [String(j.damage.types)] : [];
  j.damage.severity = ['minor', 'moderate', 'severe'].includes(j.damage.severity) ? j.damage.severity : 'minor';
  j.evidence = j.evidence || {};
  j.evidence.photos = (inputs.photos.length
    ? inputs.photos.map((p, i) => ({ index: i + 1, filename: p.name, visual_findings: [inputs.vision[i] || ''], tags: p.tags }))
    : []);
  j.evidence.voice = { transcript: inputs.transcript, source: inputs.voiceSource || (inputs.transcript ? 'typed' : 'none') };
  if (!j.recommended_action) j.recommended_action = 'refund';
  return j;
}

/* ------------------------------------------------------------------ */
/*  Demo-mode heuristics                                                */
/* ------------------------------------------------------------------ */

function demoVision(photos) {
  return photos.map(p => p.tags && p.tags.length
    ? `shows ${p.tags.join(', ').toLowerCase()}`
    : 'no tags set — damage indicators unclear from tags alone');
}

function demoLLM(inputs) {
  const tagCount = {};
  (inputs.photos || []).forEach(p => (p.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const types = new Set(Object.keys(tagCount).filter(t => t !== 'Box intact'));
  const text = (inputs.transcript || '') + ' ' + (inputs.order && inputs.order.item || '');
  KEYWORD_HITS.forEach(([re, t]) => { if (re.test(text)) types.add(t); });
  const typesArr = [...types];

  let score = 0;
  Object.entries(tagCount).forEach(([t, n]) => { score += (SEV_WEIGHT[t] || 0) * n; });
  if (/broke|broken|shatter|crack|leak|spill/i.test(text)) score += 2;
  if (/missing|empty/i.test(text)) score += 1;
  const severity = score >= 4 ? 'severe' : score >= 2 ? 'moderate' : 'minor';

  const item = (inputs.order && inputs.order.item) || 'the ordered item';
  const value = inputs.order && inputs.order.value_inr;
  const action = severity === 'severe' || (value && value >= 2000) ? 'refund'
    : severity === 'moderate' ? 'replacement'
    : 'repair or partial refund';

  const damagePhrase = typesArr.length ? typesArr.join(', ') : 'damage as shown in the attached photos';
  const courier = inputs.order && inputs.order.courier;
  const oid = inputs.order && inputs.order.order_id;
  const summary =
    `The parcel containing ${item}${oid ? ` (order ${oid})` : ''} ` +
    `arrived in damaged condition${courier ? ` via ${courier}` : ''}. ` +
    `Observed damage: ${damagePhrase}. ` +
    (inputs.transcript ? `Customer account: "${String(inputs.transcript).trim()}" ` : '') +
    `Overall severity is assessed as ${severity}. Recommended resolution: ${action}.`;

  return normalizeReport({
    damage: { types: typesArr, severity, summary },
    recommended_action: action
  }, inputs);
}

module.exports = {
  hasKey,
  DAMAGE_TAGS,
  transcribeAudio,
  analyzePhoto,
  generateReportLive,
  demoVision,
  demoLLM
};
