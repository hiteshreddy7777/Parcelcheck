/**
 * ParcelCheck — Express server
 *
 * Serves the frontend from /public and exposes the API:
 *
 *   GET  /api/health              server + pipeline status
 *   POST /api/stt                 audio buffer -> Saaras v3 transcript
 *   POST /api/analyze-photos      photo data URLs -> per-photo vision findings
 *   POST /api/generate-report     all evidence -> structured damage report
 *   POST /api/claims              persist a claim
 *   GET  /api/claims              list saved claims
 *   GET  /api/claims/:id          fetch one claim
 *   PATCH /api/claims/:id         update status / summary
 *
 * Set SARVAM_API_KEY in the environment (or .env — see .env.example)
 * to switch the pipeline from demo mode to live Sarvam AI calls.
 */
'use strict';

const path = require('path');
const express = require('express');
const store = require('./lib/store');
const sarvam = require('./lib/sarvam');

const app = express();
const PORT = process.env.PORT || 3000;

/* parse the env file by hand (avoids an extra dependency) */
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');
  if (!process.env.SARVAM_API_KEY && fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env — demo mode */ }

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

/* ------------------------------ health ------------------------------ */
app.get('/api/health', (_req, res) => {
  res.json({
    app: 'ParcelCheck',
    version: '1.0.0',
    mode: sarvam.hasKey() ? 'live' : 'demo',
    pipeline: {
      vision: sarvam.hasKey() ? 'gemma4 (image input, beta)' : 'simulated (tag-based)',
      speech: sarvam.hasKey() ? 'saaras:v3' : 'browser speech recognition / typed',
      report: sarvam.hasKey() ? 'sarvam-105b' : 'local heuristics'
    }
  });
});

/* ------------------------------ speech to text ------------------------------ */
app.post('/api/stt',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'no audio body received' });
    }
    if (!sarvam.hasKey()) {
      return res.json({ mode: 'demo', transcript: null });
    }
    try {
      const transcript = await sarvam.transcribeAudio(
        req.body,
        req.headers['content-type'],
        req.query.language
      );
      res.json({ mode: 'live', transcript });
    } catch (err) {
      /* live call failed — tell the client so it can fall back locally */
      res.status(502).json({ mode: 'live', error: err.message });
    }
  }
);

/* ------------------------------ photo analysis ------------------------------ */
app.post('/api/analyze-photos', async (req, res) => {
  const photos = Array.isArray(req.body.photos) ? req.body.photos.slice(0, 8) : [];
  if (!photos.length) return res.status(400).json({ error: 'no photos provided' });

  if (!sarvam.hasKey()) {
    return res.json({ mode: 'demo', findings: sarvam.demoVision(photos) });
  }
  const findings = [];
  for (const p of photos.slice(0, 3)) {          /* live: cap at 3 calls */
    try {
      findings.push(await sarvam.analyzePhoto(p.dataUrl));
    } catch (err) {
      findings.push(`[live vision failed: ${err.message} — falling back to tags] ${tagSentence(p)}`);
    }
  }
  while (findings.length < photos.length) findings.push(tagSentence(photos[findings.length]));
  res.json({ mode: 'live', findings });
});

function tagSentence(p) {
  return p.tags && p.tags.length
    ? `shows ${p.tags.join(', ').toLowerCase()}`
    : 'no tags set — damage indicators unclear from tags alone';
}

/* ------------------------------ report generation ------------------------------ */
app.post('/api/generate-report', async (req, res) => {
  const { transcript, vision, photos, order, voiceSource } = req.body || {};
  const inputs = {
    transcript: String(transcript || '').slice(0, 4000),
    vision: Array.isArray(vision) ? vision : [],
    photos: Array.isArray(photos) ? photos : [],
    order: order && typeof order === 'object' ? order : {},
    voiceSource
  };
  try {
    if (sarvam.hasKey()) {
      const report = await sarvam.generateReportLive(inputs);
      return res.json({ mode: 'live', engine: 'sarvam-105b', report });
    }
  } catch (err) {
    const report = sarvam.demoLLM(inputs);
    return res.json({ mode: 'demo', engine: 'demo (fallback)', error: err.message, report });
  }
  const report = sarvam.demoLLM(inputs);
  res.json({ mode: 'demo', engine: 'local heuristics', report });
});

/* ------------------------------ claims CRUD ------------------------------ */
app.post('/api/claims', (req, res) => {
  const claim = req.body;
  if (!claim || !claim.damage || !claim.order) {
    return res.status(400).json({ error: 'claim must include damage and order sections' });
  }
  res.status(201).json(store.addClaim(claim));
});

app.get('/api/claims', (_req, res) => {
  res.json(store.listClaims());
});

app.get('/api/claims/:id', (req, res) => {
  const c = store.getClaim(req.params.id);
  if (!c) return res.status(404).json({ error: 'claim not found' });
  res.json(c);
});

app.patch('/api/claims/:id', (req, res) => {
  const c = store.updateClaim(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'claim not found' });
  res.json(c);
});

/* ------------------------------ static frontend ------------------------------ */
app.use(express.static(path.join(__dirname, 'public')));

/* eslint-disable-next-line no-unused-vars */
app.use((err, _req, res, _next) => {
  console.error('[parcelcheck]', err.message);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  ParcelCheck running at http://localhost:${PORT}`);
  console.log(`  Pipeline mode: ${sarvam.hasKey() ? 'LIVE (Sarvam AI)' : 'DEMO (set SARVAM_API_KEY to go live)'}\n`);
});
