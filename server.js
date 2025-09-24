// server.js (ESM)
// Enriches Vapi calls with HubSpot context, supports both /assistant-request and /webhook.
// Requires env: HUBSPOT_PRIVATE_APP_TOKEN
// Install: npm i express cors axios @hubspot/api-client dotenv

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Client as HubSpot } from '@hubspot/api-client';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- HubSpot Client ----
if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
  console.warn('[WARN] HUBSPOT_PRIVATE_APP_TOKEN is not set. Responses will have empty variables.');
}
const hubspot = new HubSpot({
  accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN || 'missing'
});

// ---- Utils ----
const get = (obj, path, fb = undefined) =>
  path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj) ?? fb;

// (Very) basic US-normalizer; adjust if you handle intl numbers.
const normalizePhone = (raw = '') =>
  raw.replace(/[^\d+]/g, '').replace(/^1(\d{10})$/, '+1$1');

// Build a compact, human-reading summary we can surface in the assistant’s opener.
function buildLastSummary({ contact, deal }) {
  const fn = get(contact, 'properties.firstname', '');
  const ln = get(contact, 'properties.lastname', '');
  const email = get(contact, 'properties.email', '');
  const phone = get(contact, 'properties.phone', '');
  const addr = get(deal, 'properties.address', '') || get(contact, 'properties.address', '');
  const city = get(deal, 'properties.city', '') || get(contact, 'properties.city', '');
  const state = get(deal, 'properties.state', '') || get(contact, 'properties.state', '');
  const type = get(deal, 'properties.property_type', ''); // custom if you track land/house
  const price = get(deal, 'properties.asking_price', '') || get(deal, 'properties.amount', '');
  const timeline = get(deal, 'properties.timeline', '');   // e.g., weeks/months
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

// ---- HubSpot helpers ----
async function searchContactsByPhone(phone) {
  try {
    const q = normalizePhone(phone);
    if (!q) return [];
    const resp = await hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1', '') }]
      }],
      properties: ['firstname', 'lastname', 'email', 'phone', 'address', 'city', 'state', 'zip'],
      limit: 5
    });
    return resp?.results || [];
  } catch (e) {
    console.error('searchContactsByPhone error:', e.response?.data || e.message);
    return [];
  }
}

async function getDealsForContact(contactId) {
  try {
    const assoc = await hubspot.crm.contacts.associationsApi.getAll('contacts', contactId, 'deals');
    const ids = (assoc?.results || []).map(r => r.to?.id).filter(Boolean);
    if (!ids.length) return [];
    const batch = await hubspot.crm.deals.batchApi.read({
      inputs: ids.map(id => ({ id })),
      properties: [
        'dealname', 'amount',
        'address', 'city', 'state', 'zip',
        'property_type', 'asking_price', 'timeline', 'motivation'
      ]
    });
    return batch?.results || [];
  } catch (e) {
    console.error('getDealsForContact error:', e.response?.data || e.message);
    return [];
  }
}

async function searchDealsByAddress(addressLike) {
  try {
    if (!addressLike) return [];
    const resp = await hubspot.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
      properties: [
        'dealname', 'amount',
        'address', 'city', 'state', 'zip',
        'property_type', 'asking_price', 'timeline', 'motivation'
      ],
      limit: 5
    });
    return resp?.results || [];
  } catch (e) {
    console.error('searchDealsByAddress error:', e.response?.data || e.message);
    return [];
  }
}

// ---- Core builder ----
async function buildAssistantOverride(payload = {}) {
  // Accept multiple naming styles from Vapi / your app:
  const phone = payload.phone || payload.from || payload.callerPhone || '';
  const property_address = payload.property_address || payload.address || '';
  const city = payload.city || '';
  const state = payload.state || '';
  const caller_name = payload.caller_name || payload.name || '';

  let contact = null;
  let deals = [];
  let deal = null;

  // 1) Contact by phone
  const contacts = await searchContactsByPhone(phone);
  if (contacts.length) {
    contact = contacts[0];
    // 2) Associated deals
    deals = await getDealsForContact(contact.id);
  }

  // 3) If none, try address search
  if (!deals.length && property_address) {
    deals = await searchDealsByAddress(property_address);
  }
  if (deals.length) deal = deals[0];

  // 4) Variables for assistant
  const vars = {
    seller_first_name: caller_name || get(contact, 'properties.firstname', '') || '',
    property_address: get(deal, 'properties.address', '') || property_address || '',
    city: get(deal, 'properties.city', '') || city || '',
    state: get(deal, 'properties.state', '') || state || '',
    last_summary: buildLastSummary({ contact, deal })
  };

  // 5) Natural opener glue
  let instructions_append = '';
  if (vars.property_address || vars.last_summary) {
    instructions_append =
      `OPEN LIKE THIS (adjust naturally): "Hey ${vars.seller_first_name || ''}, ` +
      `thanks for taking the time about ${vars.property_address || 'your property'}` +
      `${vars.city ? ' in ' + vars.city : ''}. ` +
      `${vars.last_summary ? 'Quick heads up: ' + vars.last_summary + '. ' : ''}` +
      `Mind if I ask a couple quick questions so PG can review options?"`;
  }

  return { assistantOverride: { variables: vars, instructions_append } };
}

// ---- Handlers ----
async function handler(req, res) {
  try {
    // Minimal log to verify payload shape during testing (comment out if noisy)
    // console.log('Incoming payload keys:', Object.keys(req.body || {}));
    const override = await buildAssistantOverride(req.body || {});
    res.json(override);
  } catch (e) {
    console.error('assistant handler fatal:', e);
    res.status(200).json({ assistantOverride: { variables: {}, instructions_append: '' } });
  }
}

// Primary route expected by your current config
app.post('/assistant-request', handler);

// Alias for older configs still calling /webhook (your logs had this)
app.post('/webhook', handler);

// Health + quick info
app.get('/health', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.json({ ok: true, service: 'vapi-hubspot-bridge' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Assistant webhook running on :' + PORT));
