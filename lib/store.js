/**
 * Claims store — a simple JSON-file persistence layer.
 * Zero external dependencies; swap for SQLite/Postgres later without
 * changing the route layer.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE = path.join(DATA_DIR, 'claims.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { claims: [], seq: 0 };
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2));
}

function addClaim(claim) {
  const db = load();
  db.seq += 1;
  claim.claim = claim.claim || {};
  /* the store owns final claim IDs: temp IDs from the draft become sequential PC-#### */
  claim.claim.claim_id = `PC-${String(db.seq).padStart(4, '0')}`;
  claim.claim.saved_at = new Date().toISOString();
  claim.status = claim.status || 'draft';
  db.claims.unshift(claim);
  save(db);
  return claim;
}

function listClaims() {
  return load().claims.map(c => ({
    claim_id: c.claim && c.claim.claim_id,
    status: c.status || 'draft',
    saved_at: c.claim && c.claim.saved_at,
    item: c.order && c.order.item,
    order_id: c.order && c.order.order_id,
    severity: c.damage && c.damage.severity,
    recommended_action: c.recommended_action
  }));
}

function getClaim(id) {
  return load().claims.find(c => c.claim && c.claim.claim_id === id) || null;
}

function updateClaim(id, patch) {
  const db = load();
  const c = db.claims.find(x => x.claim && x.claim.claim_id === id);
  if (!c) return null;
  if (patch.status && ['draft', 'submitted', 'resolved'].includes(patch.status)) c.status = patch.status;
  if (typeof patch.summary === 'string' && c.damage) c.damage.summary = patch.summary;
  save(db);
  return c;
}

module.exports = { addClaim, listClaims, getClaim, updateClaim };
