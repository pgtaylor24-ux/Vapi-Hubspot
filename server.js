// server.js (ESM) – Vapi ↔ HubSpot bridge
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';

let HubSpotClient = null;
try {
  // Optional: if the SDK is installed, we’ll use it; otherwise we’ll fallback to REST via axios.
  const mod = await import('@hubspot/api-client');
  HubSpotClient = mod.Client;
  console.log('[init] Using @hubspot/api-client SDK');
} catch {
  console.warn('[init] @hubspot/api-client not found. Falling back to REST via axios.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || '';
if (!HUBSPOT_TOKEN) {
  console.warn('[WARN] HUBSPOT_PRIVATE_APP_TOKEN is not set.');
}

// ---------- HubSpot helpers ----------
const get = (obj, path, fb = undefined) =>
  path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj) ?? fb;

const normalizePhone = (raw = '') =>
  raw.replace(/[^\d+]/g, '').replace(/^1(\d{10})$/, '+1$1');

let hubspot = null;
if (HubSpotClient && HUBSPOT_TOKEN) {
  hubspot = new HubSpotClient({ accessToken: HUBSPOT_TOKEN });
}

async function hsSearchContactsByPhone(phone) {
  const q = normalizePhone(phone);
  if (!q) return [];

  // Use SDK if available
  if (hubspot) {
    try {
      const resp = await hubspot.crm.contacts.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1','') }] }],
        properties: ['firstname','lastname','email','phone','address','city','state','zip'],
        limit: 5
      });
      return resp.results || [];
    } catch (e) {
      console.error('SDK searchContactsByPhone error:', e.response?.data || e.message);
      return [];
    }
  }

  // Fallback REST
  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: q.replace('+1','') }] }],
      properties: ['firstname','lastname','email','phone','address','city','state','zip'],
      limit: 5
    };
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    return resp.data?.results || [];
  } catch (e) {
    console.error('REST searchContactsByPhone error:', e.response?.data || e.message);
    return [];
  }
}

async function hsGetDealsForContact(contactId) {
  // SDK path
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
    } catch (e) {
      console.error('SDK getDealsForContact error:', e.response?.data || e.message);
      return [];
    }
  }

  // REST path
  try {
    // list associations
    const assocUrl = `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals`;
    const assoc = await axios.get(assocUrl, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    const ids = (assoc.data?.results || []).map(r => r.toObjectId).filter(Boolean);
    if (!ids.length) return [];
    // batch read
    const readUrl = 'https://api.hubapi.com/crm/v3/objects/deals/batch/read';
    const body = {
      properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
      inputs: ids.map(id => ({ id: String(id) }))
    };
    const batch = await axios.post(readUrl, body, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    return batch.data?.results || [];
  } catch (e) {
    console.error('REST getDealsForContact error:', e.response?.data || e.message);
    return [];
  }
}

async function hsSearchDealsByAddress(addressLike) {
  if (!addressLike) return [];
  // SDK path
  if (hubspot) {
    try {
      const resp = await hubspot.crm.deals.searchApi.doSearch({
        filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
        properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
        limit: 5
      });
      return resp?.results || [];
    } catch (e) {
      console.error('SDK searchDealsByAddress error:', e.response?.data || e.message);
      return [];
    }
  }
  // REST path
  try {
    const url = 'https://api.hubapi.com/crm/v3/objects/deals/search';
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }] }],
      properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
      limit: 5
    };
    const resp = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });
    return resp.data?.results || [];
  } catch (e) {
    console.error('REST searchDealsByAddress error:', e.response?.data || e.message);
    return [];
  }
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

  return { assistantOverride: { variables: vars, instructions_append } };
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

app.post('/assistant-request', handler);
app.post('/webhook', handler);

app.get('/health', (_, res) => res.send('ok'));

// quick diagnostics endpoint
app.get('/diag', (_, res) => {
  res.json({
    node: process.versions.node,
    hasHubSpotSDK: !!hubspot,
    envHasToken: !!HUBSPOT_TOKEN
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Assistant webhook running on :' + PORT));
