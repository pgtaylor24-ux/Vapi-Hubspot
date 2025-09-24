// server.js (ESM) – Vapi ↔ HubSpot bridge with voice override + /log notes
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

let HubSpotClient = null;
try {
  const mod = await import('@hubspot/api-client');
  HubSpotClient = mod.Client;
  console.log('[init] Using @hubspot/api-client SDK');
} catch {
  console.warn('[init] @hubspot/api-client not found. Falling back to REST via axios.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- ENV ----------
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || '';
if (!HUBSPOT_TOKEN) console.warn('[WARN] HUBSPOT_PRIVATE_APP_TOKEN is not set.');

// Voice override (optional): set these in Render if you want global tuning
const VOICE_NAME = process.env.VAPI_VOICE_NAME || '';                // e.g., "sage"
const VOICE_STABILITY = process.env.VAPI_VOICE_STABILITY || '';      // e.g., "0.35"
const VOICE_SIMILARITY = process.env.VAPI_VOICE_SIMILARITY || '';    // e.g., "0.85"
const VOICE_STYLE = process.env.VAPI_VOICE_STYLE || '';              // e.g., "conversational, approachable, calm, short sentences"

let hubspot = null;
if (HubSpotClient && HUBSPOT_TOKEN) hubspot = new HubSpotClient({ accessToken: HUBSPOT_TOKEN });

// ---------- Utils ----------
const get = (obj, path, fb = undefined) =>
  path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj) ?? fb;

const normalizePhone = (raw = '') =>
  raw.replace(/[^\d+]/g, '').replace(/^1(\d{10})$/, '+1$1');

// ---------- HubSpot helpers (SDK with REST fallback) ----------
async function hsSearchContactsByPhone(phone) {
  const q = normalizePhone(phone);
  if (!q) return [];
  if (hubspot) {
    try {
      const resp = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1','') }] }],
        properties: ['firstname','lastname','email','phone','address','city','state','zip'],
        limit: 5
      });
      return resp.results || [];
    } catch (e) { console.error('SDK searchContactsByPhone', e.response?.data || e.message); }
  }
  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1','') }] }],
      properties: ['firstname','lastname','email','phone','address','city','state','zip'],
      limit: 5
    };
    const resp = await axios.post(url, body, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    return resp.data?.results || [];
  } catch (e) { console.error('REST searchContactsByPhone', e.response?.data || e.message); return []; }
}

async function hsGetDealsForContact(contactId) {
  if (hubspot) {
    try {
      const assoc = await hubspot.crm.contacts.associationsApi.getAll('contacts', contactId, 'deals');
      const ids = (assoc?.results || []).map(r => r.to?.id).filter(Boolean);
      if (!ids.length) return [];
      const batch = await hubspot.crm.deals.batchApi.read({
        inputs: ids.map(id => ({ id })),
        properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation']
      });
      return batch?.results || [];
    } catch (e) { console.error('SDK getDealsForContact', e.response?.data || e.message); }
  }
  try {
    const assocUrl = `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`;
    const assoc = await axios.get(assocUrl, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    const ids = (assoc.data?.results || []).map(r => r.toObjectId).filter(Boolean);
    if (!ids.length) return [];
    const readUrl = 'https://api.hubapi.com/crm/v3/objects/deals/batch/read';
    const body = {
      properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
      inputs: ids.map(id => ({ id: String(id) }))
    };
    const batch = await axios.post(readUrl, body, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    return batch.data?.results || [];
  } catch (e) { console.error('REST getDealsForContact', e.response?.data || e.message); return []; }
}

async function hsSearchDealsByAddress(addressLike) {
  if (!addressLike) return [];
  if (hubspot) {
    try {
      const resp = await hubspot.crm.deals.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
        properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
        limit: 5
      });
      return resp?.results || [];
    } catch (e) { console.error('SDK searchDealsByAddress', e.response?.data || e.message); }
  }
  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/deals/search';
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
      properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
      limit: 5
    };
    const resp = await axios.post(url, body, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    return resp.data?.results || [];
  } catch (e) { console.error('REST searchDealsByAddress', e.response?.data || e.message); return []; }
}

function buildLastSummary({ contact, deal }) {
  const fn = get(contact, 'properties.firstname', '');
  const ln = get(contact, 'properties.lastname', '');
  const email = get(contact, 'properties.email', '');
  const phone = get(contact, 'properties.phone', '');
  const addr = get(deal, 'properties.address', '') || get(contact, 'properties.address', '');
  const city = get(deal, 'properties.city', '') || get(contact, 'properties.city', '');
  const state = get(deal, 'properties.state', '') || get(contact, 'properties.state', '');
  const type = get(deal, 'properties.property_type', '');
  const price = get(deal, 'properties.asking_price', '') || get(deal, 'properties.amount', '');
  const timeline = get(deal, 'properties.timeline', '');
  const motivation = get(deal, 'properties.motivation', '');

  const lines = [];
  if (type) lines.push(type);
  if (addr || city || state) lines.push(`${addr || ''} ${city || ''} ${state || ''}`.trim());
  if (price) lines.push(`Price feel: ${price}`);
  if (timeline) lines.push(`Timing: ${timeline}`);
  if (motivation) lines.push(`Motivation: ${motivation}`);
  if (email || phone) lines.push(`Contact: ${fn} ${ln} ${phone || ''} ${email || ''}`.trim());
  return lines.filter(Boolean).join(' • ');
}

// ---------- Core builder ----------
async function buildAssistantOverride(payload = {}) {
  const phone = payload.phone || payload.from || payload.callerPhone || '';
  const property_address = payload.property_address || payload.address || '';
  const city = payload.city || '';
  const state = payload.state || '';
  const caller_name = payload.caller_name || payload.name || '';

  let contact = null, deals = [], deal = null;

  const contacts = await hsSearchContactsByPhone(phone);
  if (contacts.length) {
    contact = contacts[0];
    deals = await hsGetDealsForContact(contact.id);
  }
  if (!deals.length && property_address) {
    deals = await hsSearchDealsByAddress(property_address);
  }
  if (deals.length) deal = deals[0];

  const vars = {
    seller_first_name: caller_name || get(contact, 'properties.firstname', '') || '',
    property_address: get(deal, 'properties.address', '') || property_address || '',
    city: get(deal, 'properties.city', '') || city || '',
    state: get(deal, 'properties.state', '') || state || '',
    last_summary: buildLastSummary({ contact, deal })
  };

  let instructions_append = '';
  if (vars.property_address || vars.last_summary) {
    instructions_append =
      `OPEN LIKE THIS (adjust naturally): "Hey ${vars.seller_first_name || ''}, ` +
      `thanks for taking the time about ${vars.property_address || 'your property'}` +
      `${vars.city ? ' in ' + vars.city : ''}. ` +
      `${vars.last_summary ? 'Quick heads up: ' + vars.last_summary + '. ' : ''}` +
      `Mind if I ask a couple quick questions so PG can review options?"`;
  }

  // ---------- Voice override (env + per-request) ----------
  const voiceOverride = {};
  const reqVoiceName = payload.voice_name || payload.voiceName;
  const reqStability = payload.voice_stability ?? payload.voiceStability;
  const reqSimilarity = payload.voice_similarity ?? payload.voiceSimilarity;
  const reqStyle = payload.voice_style || payload.voiceStyle;

  const name = reqVoiceName || VOICE_NAME;
  const stability = (reqStability !== undefined ? reqStability : VOICE_STABILITY);
  const similarity = (reqSimilarity !== undefined ? reqSimilarity : VOICE_SIMILARITY);
  const style = reqStyle || VOICE_STYLE;

  if (name || stability !== '' || similarity !== '' || style) {
    voiceOverride.provider = 'openai';
    if (name) voiceOverride.name = String(name);
    if (stability !== '') voiceOverride.stability = Number(stability);
    if (similarity !== '') voiceOverride.similarity_boost = Number(similarity);
    if (style) voiceOverride.style = String(style);
  }

  return {
    assistantOverride: {
      ...(Object.keys(voiceOverride).length ? { voice: voiceOverride } : {}),
      variables: vars,
      instructions_append
    }
  };
}

// ---------- Notes helpers ----------
async function hsCreateNoteAndAssociate({ body, contactId, dealId }) {
  // Create the note
  let noteId = null;

  // SDK path
  if (hubspot) {
    try {
      const created = await hubspot.crm.notes.basicApi.create({
        properties: { hs_note_body: body }
      });
      noteId = created?.id;
    } catch (e) {
      console.error('SDK create note error:', e.response?.data || e.message);
    }
    // Associate if created
    try {
      if (noteId && contactId) {
        await hubspot.crm.notes.associationsApi.create(noteId, 'contacts', contactId, 'note_to_contact');
      }
      if (noteId && dealId) {
        await hubspot.crm.notes.associationsApi.create(noteId, 'deals', dealId, 'note_to_deal');
      }
    } catch (e) {
      console.error('SDK note association error:', e.response?.data || e.message);
    }
    return noteId;
  }

  // REST fallback
  try {
    const createUrl = 'https://api.hubapi.com/crm/v3/objects/notes';
    const created = await axios.post(createUrl, {
      properties: { hs_note_body: body }
    }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    noteId = created?.data?.id;
  } catch (e) {
    console.error('REST create note error:', e.response?.data || e.message);
  }
  // Associate (REST v3 associations)
  try {
    if (noteId && contactId) {
      const assocUrl = `https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`;
      await axios.put(assocUrl, {}, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    }
    if (noteId && dealId) {
      const assocUrl = `https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/deals/${dealId}/note_to_deal`;
      await axios.put(assocUrl, {}, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }});
    }
  } catch (e) {
    console.error('REST note association error:', e.response?.data || e.message);
  }
  return noteId;
}

function buildNoteBody(payload = {}) {
  // Payload can include: phone, property_address, city, state, motivation, timeline, price_feel, extras, outcome, next_step, scheduled_time, transcript
  const parts = [];
  if (payload.property_address || payload.city || payload.state) {
    parts.push(`Property: ${[payload.property_address, payload.city, payload.state].filter(Boolean).join(', ')}`);
  }
  if (payload.motivation) parts.push(`Motivation: ${payload.motivation}`);
  if (payload.timeline) parts.push(`Timeline: ${payload.timeline}`);
  if (payload.price_feel) parts.push(`Price feel: ${payload.price_feel}`);
  if (payload.extras) parts.push(`Facts: ${payload.extras}`);
  if (payload.outcome) parts.push(`Outcome: ${payload.outcome}`);
  if (payload.next_step) parts.push(`Next step: ${payload.next_step}`);
  if (payload.scheduled_time) parts.push(`Scheduled: ${payload.scheduled_time}`);
  if (payload.transcript) parts.push(`Transcript:\n${payload.transcript}`);
  if (payload.phone) parts.push(`Phone: ${payload.phone}`);
  return parts.join('\n');
}

// ---------- Routes ----------
async function handler(req, res) {
  try {
    const override = await buildAssistantOverride(req.body || {});
    res.json(override);
  } catch (e) {
    console.error('assistant handler fatal:', e);
    res.status(200).json({ assistantOverride: { variables: {}, instructions_append: '' }});
  }
}

// Called by Vapi: enrich variables/voice each call
app.post('/assistant-request', handler);
app.post('/webhook', handler);

// Optional: health + diag
app.get('/health', (_, res) => res.send('ok'));
app.get('/diag', (_, res) => {
  res.json({
    node: process.versions.node,
    hasHubSpotSDK: !!hubspot,
    envHasToken: !!HUBSPOT_TOKEN,
    voiceEnv: {
      name: VOICE_NAME || null,
      stability: VOICE_STABILITY || null,
      similarity: VOICE_SIMILARITY || null,
      style: VOICE_STYLE || null
    }
  });
});

// New: /log – write a HubSpot Note associated to contact (and first deal if found)
app.post('/log', async (req, res) => {
  try {
    const p = req.body || {};
    const phone = p.phone || p.from || p.callerPhone || '';
    let contactId = null;
    let dealId = null;

    // Find contact by phone
    const contacts = await hsSearchContactsByPhone(phone);
    if (contacts.length) contactId = contacts[0].id;

    // Try to find a deal by contact association or address
    if (contactId) {
      const deals = await hsGetDealsForContact(contactId);
      if (deals?.length) dealId = deals[0].id;
    }
    if (!dealId && p.property_address) {
      const dealsByAddr = await hsSearchDealsByAddress(p.property_address);
      if (dealsByAddr?.length) dealId = dealsByAddr[0].id;
    }

    const body = buildNoteBody(p);
    const noteId = await hsCreateNoteAndAssociate({ body, contactId, dealId });

    res.json({ ok: true, noteId, contactId, dealId });
  } catch (e) {
    console.error('/log fatal:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Assistant webhook running on :' + PORT));
