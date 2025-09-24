// server.js (ESM) – Vapi ↔ HubSpot bridge with voice override, lead status, and logging
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

// --- Try HubSpot SDK first; fall back to REST if not installed ---
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
if (!HUBSPOT_TOKEN) console.warn('[WARN] HUBSPOT_PRIVATE_APP_TOKEN is not set. HubSpot calls will be skipped.');

const VOICE_NAME = process.env.VAPI_VOICE_NAME || '';                // e.g., "sage"
const VOICE_STABILITY = process.env.VAPI_VOICE_STABILITY || '';      // e.g., "0.25"
const VOICE_SIMILARITY = process.env.VAPI_VOICE_SIMILARITY || '';    // e.g., "0.85"
const VOICE_STYLE = process.env.VAPI_VOICE_STYLE || '';              // e.g., "conversational, approachable, calm, short sentences"

let hubspot = null;
if (HubSpotClient && HUBSPOT_TOKEN) {
  hubspot = new HubSpotClient({ accessToken: HUBSPOT_TOKEN });
}

// ---------- Utils ----------
const get = (obj, path, fb = undefined) =>
  path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj) ?? fb;

const normalizePhone = (raw = '') =>
  raw.replace(/[^\d+]/g, '').replace(/^1(\d{10})$/, '+1$1');

const log = (level, message, data = null) => {
  const ts = new Date().toISOString();
  const suffix = data != null ? ` | Data: ${JSON.stringify(data, null, 2)}` : '';
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}${suffix}`);
};

// ---------- HubSpot helpers (SDK with REST fallback) ----------
async function hsSearchContactsByPhone(phone) {
  const q = normalizePhone(phone);
  if (!q || !HUBSPOT_TOKEN) return [];
  log('info', `Searching contacts for phone: ${q}`);

  // SDK
  if (hubspot) {
    try {
      const resp = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [
          { filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1', '') }] }
        ],
        properties: ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip'],
        limit: 5
      });
      log('info', `SDK found ${resp.results?.length || 0} contacts`);
      return resp.results || [];
    } catch (e) {
      log('error', 'SDK searchContactsByPhone failed', e.response?.data || e.message);
    }
  }
  // REST
  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const body = {
      filterGroups: [
        { filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1', '') }] }
      ],
      properties: ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip'],
      limit: 5
    };
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    log('info', `REST found ${resp.data?.results?.length || 0} contacts`);
    return resp.data?.results || [];
  } catch (e) {
    log('error', 'REST searchContactsByPhone failed', e.response?.data || e.message);
    return [];
  }
}

async function hsGetDealsForContact(contactId) {
  if (!contactId || !HUBSPOT_TOKEN) return [];
  log('info', `Getting deals for contact: ${contactId}`);

  // SDK
  if (hubspot) {
    try {
      const assoc = await hubspot.crm.contacts.associationsApi.getAll('contacts', contactId, 'deals');
      const ids = (assoc?.results || []).map(r => r.to?.id).filter(Boolean);
      if (!ids.length) return [];
      const batch = await hubspot.crm.deals.batchApi.read({
        inputs: ids.map(id => ({ id })),
        properties: ['dealname', 'amount', 'address', 'city', 'state', 'zip', 'property_type', 'asking_price', 'timeline', 'motivation']
      });
      log('info', `SDK found ${batch?.results?.length || 0} deals`);
      return batch?.results || [];
    } catch (e) {
      log('error', 'SDK getDealsForContact failed', e.response?.data || e.message);
    }
  }
  // REST
  try {
    const assocUrl = `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`;
    const assoc = await axios.get(assocUrl, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    const ids = (assoc.data?.results || []).map(r => r.toObjectId).filter(Boolean);
    if (!ids.length) return [];
    const readUrl = 'https://api.hubapi.com/crm/v3/objects/deals/batch/read';
    const body = {
      properties: ['dealname', 'amount', 'address', 'city', 'state', 'zip', 'property_type', 'asking_price', 'timeline', 'motivation'],
      inputs: ids.map(id => ({ id: String(id) }))
    };
    const batch = await axios.post(readUrl, body, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    log('info', `REST found ${batch.data?.results?.length || 0} deals`);
    return batch.data?.results || [];
  } catch (e) {
    log('error', 'REST getDealsForContact failed', e.response?.data || e.message);
    return [];
  }
}

async function hsSearchDealsByAddress(addressLike) {
  if (!addressLike || !HUBSPOT_TOKEN) return [];
  log('info', `Searching deals by address: ${addressLike}`);

  // SDK
  if (hubspot) {
    try {
      const resp = await hubspot.crm.deals.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
        properties: ['dealname', 'amount', 'address', 'city', 'state', 'zip', 'property_type', 'asking_price', 'timeline', 'motivation'],
        limit: 5
      });
      log('info', `SDK found ${resp?.results?.length || 0} deals by address`);
      return resp?.results || [];
    } catch (e) {
      log('error', 'SDK searchDealsByAddress failed', e.response?.data || e.message);
    }
  }
  // REST
  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/deals/search';
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
      properties: ['dealname', 'amount', 'address', 'city', 'state', 'zip', 'property_type', 'asking_price', 'timeline', 'motivation'],
      limit: 5
    };
    const resp = await axios.post(url, body, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    log('info', `REST found ${resp.data?.results?.length || 0} deals by address`);
    return resp.data?.results || [];
  } catch (e) {
    log('error', 'REST searchDealsByAddress failed', e.response?.data || e.message);
    return [];
  }
}

async function hsCreateNoteAndAssociate({ body, contactId, dealId }) {
  if (!HUBSPOT_TOKEN) return null;
  log('info', 'Creating note', { contactId, dealId, bodyLength: body?.length });

  let noteId = null;

  // SDK
  if (hubspot) {
    try {
      const created = await hubspot.crm.notes.basicApi.create({
        properties: { hs_note_body: body }
      });
      noteId = created?.id;
      log('info', `SDK created note: ${noteId}`);
    } catch (e) {
      log('error', 'SDK create note failed', e.response?.data || e.message);
    }
    try {
      if (noteId && contactId) {
        await hubspot.crm.notes.associationsApi.create(noteId, 'contacts', contactId, 'note_to_contact');
      }
      if (noteId && dealId) {
        await hubspot.crm.notes.associationsApi.create(noteId, 'deals', dealId, 'note_to_deal');
      }
      return noteId;
    } catch (e) {
      log('error', 'SDK note association failed', e.response?.data || e.message);
      return noteId;
    }
  }

  // REST
  try {
    const createUrl = 'https://api.hubapi.com/crm/v3/objects/notes';
    const created = await axios.post(createUrl, { properties: { hs_note_body: body } }, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    noteId = created?.data?.id;
    log('info', `REST created note: ${noteId}`);
  } catch (e) {
    log('error', 'REST create note failed', e.response?.data || e.message);
  }
  try {
    if (noteId && contactId) {
      const u1 = `https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/contacts/${contactId}/note_to_contact`;
      await axios.put(u1, {}, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    }
    if (noteId && dealId) {
      const u2 = `https://api.hubapi.com/crm/v3/objects/notes/${noteId}/associations/deals/${dealId}/note_to_deal`;
      await axios.put(u2, {}, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    }
  } catch (e) {
    log('error', 'REST note association failed', e.response?.data || e.message);
  }
  return noteId;
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

// ---------- Assistant override builder ----------
async function buildAssistantOverride(payload = {}) {
  const phone = payload.phone || payload.from || payload.callerPhone || '';
  const property_address = payload.property_address || payload.address || '';
  const city = payload.city || '';
  const state = payload.state || '';
  const caller_name = payload.caller_name || payload.name || '';

  log('info', 'Building assistant override', { phone, property_address, city, state, caller_name });

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
    name: caller_name || get(contact, 'properties.firstname', '') || '',
    property_address: get(deal, 'properties.address', '') || property_address || '',
    propertyAddress: get(deal, 'properties.address', '') || property_address || '',
    city: get(deal, 'properties.city', '') || city || '',
    state: get(deal, 'properties.state', '') || state || '',
    last_summary: buildLastSummary({ contact, deal })
  };

  // Optional: prepend an opening suggestion to sound even more natural
  let instructions_append = '';
  if (vars.property_address || vars.last_summary) {
    instructions_append =
      `OPEN LIKE THIS (adjust naturally): "Hi ${vars.seller_first_name ? vars.seller_first_name + ', ' : ''}` +
      `this is Alex with Taylor Real Estate Group. I'm calling about ${vars.property_address || 'your property'}` +
      `${vars.city ? ' in ' + vars.city : ''}. Did I catch you at an okay moment?" ` +
      `${vars.last_summary ? 'Previous context: ' + vars.last_summary + '. ' : ''}` +
      `Don't read it robotically; keep it conversational.`;
  }

  // Voice override (env + per-request)
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

  const response = {
    assistantOverride: {
      ...(Object.keys(voiceOverride).length ? { voice: voiceOverride } : {}),
      variables: vars,
      instructions_append
    }
  };

  log('info', 'Final assistant override response', response);
  return response;
}

// ---------- Build a HubSpot note body ----------
function buildNoteBody(payload = {}) {
  const parts = [];
  const timestamp = new Date().toLocaleString();
  parts.push(`Call Summary - ${timestamp}`);
  parts.push('---');

  if (payload.property_address || payload.city || payload.state) {
    parts.push(`Property: ${[payload.property_address, payload.city, payload.state].filter(Boolean).join(', ')}`);
  }
  if (payload.motivation) parts.push(`Motivation: ${payload.motivation}`);
  if (payload.timeline) parts.push(`Timeline: ${payload.timeline}`);
  if (payload.price_feel) parts.push(`Price feel: ${payload.price_feel}`);
  if (payload.extras) parts.push(`Additional facts: ${payload.extras}`);
  if (payload.outcome) parts.push(`Call outcome: ${payload.outcome}`);
  if (payload.next_step) parts.push(`Next step: ${payload.next_step}`);
  if (payload.scheduled_time) parts.push(`Follow-up scheduled: ${payload.scheduled_time}`);
  if (payload.phone) parts.push(`Phone: ${payload.phone}`);

  if (payload.transcript) {
    parts.push('---');
    parts.push('Full Transcript:');
    parts.push(payload.transcript);
  }
  return parts.join('\n');
}

// ---------- Core handler ----------
async function assistantHandler(req, res) {
  try {
    log('info', `Handling ${req.method} ${req.path}`, req.body);
    const override = await buildAssistantOverride(req.body || {});
    res.json(override);
  } catch (e) {
    log('error', 'assistantHandler fatal error', e);
    res.status(200).json({
      assistantOverride: {
        variables: {},
        instructions_append: ''
      }
    });
  }
}

// ---------- Routes ----------
app.get('/', (_, res) => res.status(200).send('assistant webhook ok'));
app.get('/health', (_, res) => res.status(200).send('ok'));
app.get('/diag', (_, res) => {
  const diagnostics = {
    timestamp: new Date().toISOString(),
    node: process.versions.node,
    hasHubSpotSDK: !!hubspot,
    envHasToken: !!HUBSPOT_TOKEN,
    voiceEnv: {
      name: VOICE_NAME || null,
      stability: VOICE_STABILITY || null,
      similarity: VOICE_SIMILARITY || null,
      style: VOICE_STYLE || null
    }
  };
  log('info', 'Diagnostics requested', diagnostics);
  res.json(diagnostics);
});

// Enrich assistant per-call (Vapi calls one of these)
app.post('/assistant-request', assistantHandler);
app.post('/webhook', assistantHandler);

// --- Lead Status (Webhook Tool target) ---
app.post('/lead-status', async (req, res) => {
  try {
    let { leadId, status, note, stopDialingRestOfNumbers } = req.body || {};
    // Coerce "true"/"false" (string) → boolean for safer Vapi UI validation
    if (typeof stopDialingRestOfNumbers === 'string') {
      stopDialingRestOfNumbers = stopDialingRestOfNumbers.toLowerCase() === 'true';
    }
    log('info', 'setLeadStatus called', { leadId, status, note, stopDialingRestOfNumbers });
    if (!leadId || !status) {
      return res.status(400).json({ ok: false, error: 'leadId and status are required' });
    }

    // Optional: write a note to HubSpot
    if (note) {
      await hsCreateNoteAndAssociate({
        body: `Status: ${status}\nNote: ${note}\nLeadId: ${leadId}\nStop dialing rest: ${!!stopDialingRestOfNumbers}`,
        contactId: null,
        dealId: null
      });
    }

    return res.json({
      ok: true,
      leadId,
      status,
      stopDialingRestOfNumbers: !!stopDialingRestOfNumbers
    });
  } catch (e) {
    log('error', 'setLeadStatus failed', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Function-tool variant (only if you keep a Function instead of Webhook) ---
app.post('/function/setLeadStatus', async (req, res) => {
  try {
    // Some org setups send { arguments: { ... } }
    const args = req.body?.arguments || req.body || {};
    let { leadId, status, note, stopDialingRestOfNumbers } = args;
    if (typeof stopDialingRestOfNumbers === 'string') {
      stopDialingRestOfNumbers = stopDialingRestOfNumbers.toLowerCase() === 'true';
    }
    log('info', 'Function setLeadStatus invoked', { leadId, status, note, stopDialingRestOfNumbers });

    if (!leadId || !status) {
      return res.status(400).json({ ok: false, error: 'leadId and status are required' });
    }

    if (note) {
      await hsCreateNoteAndAssociate({
        body: `Status: ${status}\nNote: ${note}\nLeadId: ${leadId}\nStop dialing rest: ${!!stopDialingRestOfNumbers}`,
        contactId: null,
        dealId: null
      });
    }

    return res.json({
      ok: true,
      leadId,
      status,
      stopDialingRestOfNumbers: !!stopDialingRestOfNumbers
    });
  } catch (e) {
    log('error', 'Function setLeadStatus failed', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Rich call outcome logging (optional) ---
app.post('/log', async (req, res) => {
  try {
    const p = req.body || {};
    log('info', 'Processing log request', p);

    const phone = p.phone || p.from || p.callerPhone || '';
    let contactId = null;
    let dealId = null;

    const contacts = await hsSearchContactsByPhone(phone);
    if (contacts.length) contactId = contacts[0].id;

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

    const response = { ok: true, noteId, contactId, dealId };
    log('info', 'Log request completed successfully', response);
    res.json(response);
  } catch (e) {
    log('error', 'Log request failed', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  log('info', `Assistant webhook running on port ${PORT}`);
  log('info', 'Server configuration', {
    hasHubSpotToken: !!HUBSPOT_TOKEN,
    hasHubSpotSDK: !!hubspot,
    voiceOverrides: {
      name: VOICE_NAME || 'default',
      stability: VOICE_STABILITY || 'default',
      similarity: VOICE_SIMILARITY || 'default',
      style: VOICE_STYLE || 'default'
    }
  });
});
