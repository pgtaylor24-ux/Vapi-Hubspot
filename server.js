// server.js
// Express webhook that enriches Vapi calls with HubSpot context.
// Requires: node 18+, npm i express cors axios @hubspot/api-client dotenv

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Client as HubSpot } from '@hubspot/api-client';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- HubSpot Client ----
const hubspot = new HubSpot({
  accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN
});

// Utility: safe getter
const get = (obj, path, fallback = undefined) =>
  path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj) ?? fallback;

// Normalize phone (basic)
const normalizePhone = (raw = '') =>
  raw.replace(/[^\d+]/g, '').replace(/^1(\d{10})$/, '+1$1');

// Build a compact summary from contact/deal props
function buildLastSummary({ contact, deal }) {
  const fn = get(contact, 'properties.firstname', '');
  const ln = get(contact, 'properties.lastname', '');
  const email = get(contact, 'properties.email', '');
  const phone = get(contact, 'properties.phone', '');
  const addr = get(deal, 'properties.address', '') || get(contact, 'properties.address', '');
  const city = get(deal, 'properties.city', '') || get(contact, 'properties.city', '');
  const state = get(deal, 'properties.state', '') || get(contact, 'properties.state', '');
  const zip = get(deal, 'properties.zip', '') || get(contact, 'properties.zip', '');
  const type = get(deal, 'properties.property_type', ''); // custom if you track land/house
  const price = get(deal, 'properties.asking_price', '') || get(deal, 'properties.amount', '');
  const timeline = get(deal, 'properties.timeline', '');   // e.g., weeks/months
  const motivation = get(deal, 'properties.motivation', '');

  let lines = [];
  if (type) lines.push(`${type}`);
  if (addr || city || state) lines.push(`${addr || ''} ${city || ''} ${state || ''}`.trim());
  if (price) lines.push(`Price feel: ${price}`);
  if (timeline) lines.push(`Timing: ${timeline}`);
  if (motivation) lines.push(`Motivation: ${motivation}`);
  if (email || phone) lines.push(`Contact: ${fn} ${ln} ${phone || ''} ${email || ''}`.trim());

  return lines.filter(Boolean).join(' • ');
}

// HubSpot helpers
async function searchContactsByPhone(phone) {
  const query = normalizePhone(phone);
  if (!query) return [];
  try {
    const resp = await hubspot.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: query.replace('+1','') }]
      }],
      properties: ['firstname','lastname','email','phone','address','city','state','zip'],
      limit: 5
    });
    return resp.results || [];
  } catch (e) {
    console.error('searchContactsByPhone error', e.response?.data || e.message);
    return [];
  }
}

async function getDealsForContact(contactId) {
  try {
    const resp = await hubspot.crm.contacts.associationsApi.getAll('contacts', contactId, 'deals');
    const dealIds = (resp?.results || []).map(r => r.to?.id).filter(Boolean);
    if (!dealIds.length) return [];
    const batch = await hubspot.crm.deals.batchApi.read({
      inputs: dealIds.map(id => ({ id })),
      properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation']
    });
    return (batch?.results || []).map(r => r);
  } catch (e) {
    console.error('getDealsForContact error', e.response?.data || e.message);
    return [];
  }
}

async function searchDealsByAddress(addressLike) {
  if (!addressLike) return [];
  try {
    const resp = await hubspot.crm.deals.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'address', operator: 'CONTAINS_TOKEN', value: addressLike }]
      }],
      properties: ['dealname','amount','address','city','state','zip','property_type','asking_price','timeline','motivation'],
      limit: 5
    });
    return resp.results || [];
  } catch (e) {
    console.error('searchDealsByAddress error', e.response?.data || e.message);
    return [];
  }
}

// Main webhook: enrich before assistant starts speaking
app.post('/assistant-request', async (req, res) => {
  try {
    const { phone, property_address, city, state, caller_name } = req.body || {};
    let contact = null;
    let deals = [];
    let deal = null;

    // 1) Find contact by phone
    const contacts = await searchContactsByPhone(phone);
    if (contacts.length) {
      contact = contacts[0];
      // 2) Pull associated deals
      deals = await getDealsForContact(contact.id);
    }

    // 3) If no deal and address provided, try address search
    if (!deals.length && property_address) {
      deals = await searchDealsByAddress(property_address);
    }
    if (deals.length) {
      deal = deals[0];
    }

    // 4) Build variables for the assistant
    const vars = {
      seller_first_name: caller_name || get(contact, 'properties.firstname', '') || '',
      property_address: get(deal, 'properties.address', '') || property_address || '',
      city: get(deal, 'properties.city', '') || city || '',
      state: get(deal, 'properties.state', '') || state || '',
      last_summary: buildLastSummary({ contact, deal })
    };

    // 5) Suggest an opener if we have address context
    let instructions_append = '';
    if (vars.property_address || vars.last_summary) {
      instructions_append =
        `OPEN LIKE THIS (adjust naturally): "Hey ${vars.seller_first_name || ''}, ` +
        `thanks for taking the time about ${vars.property_address || 'your property'}` +
        `${vars.city ? ' in ' + vars.city : ''}. ` +
        `${vars.last_summary ? 'Quick heads up on what I saw: ' + vars.last_summary + '. ' : ''}` +
        `Mind if I ask a couple quick questions so PG can review options?"`;
    }

    // 6) Return assistant override payload for Vapi
    res.json({
      assistantOverride: {
        variables: vars,
        instructions_append
      }
    });
  } catch (e) {
    console.error('assistant-request fatal', e);
    res.status(200).json({ assistantOverride: { variables: {}, instructions_append: '' }});
  }
});

// Healthcheck
app.get('/health', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Assistant webhook running on :' + PORT);
});
