import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import twilio from 'twilio';

const {
  PORT = 8080,
  // SECURITY: required for incoming tool calls from Vapi
  AGENT_SECRET,
  // HubSpot Private App token (scopes: crm.objects.contacts.read/write, crm.objects.notes.write)
  HUBSPOT_TOKEN,
  // Optional for SMS/notifications
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER
} = process.env;

if (!AGENT_SECRET) { console.error('Missing AGENT_SECRET'); process.exit(1); }
if (!HUBSPOT_TOKEN) { console.error('Missing HUBSPOT_TOKEN'); process.exit(1); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/** Require the x-agent-secret header on all tool routes */
function requireSecret(req, res, next) {
  const header = req.header('x-agent-secret');
  if (!header || header !== AGENT_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

/** HubSpot client */
const HUBSPOT = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
});

/** Utilities */
const normalize = (p = '') => {
  const d = p.replace(/[^\d]/g, '');
  if (!d) return p;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return `+${d}`;
};

async function findContactByPhone(phone) {
  try {
    const r = await HUBSPOT.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      properties: ['firstname', 'lastname', 'email', 'phone']
    });
    return r?.data?.results?.[0]?.id || null;
  } catch {
    return null;
  }
}
async function createContact(properties) {
  const r = await HUBSPOT.post('/crm/v3/objects/contacts', { properties });
  return r.data.id;
}
async function updateContact(id, properties) {
  const r = await HUBSPOT.patch(`/crm/v3/objects/contacts/${id}`, { properties });
  return r.data.id;
}
async function createNote(text) {
  const r = await HUBSPOT.post('/crm/v3/objects/notes', { properties: { hs_note_body: text } });
  return r.data.id;
}
async function associateNoteToContact(noteId, contactId) {
  // v3 association batch endpoint
  await HUBSPOT.put(`/crm/v3/associations/notes/contacts/batch/create`, {
    inputs: [{ from: { id: noteId }, to: { id: contactId }, type: 'note_to_contact' }]
  });
}

/** ===== Tools ===== **/

// 1) create_or_update_contact
app.post('/tools/create_or_update_contact', requireSecret, async (req, res) => {
  try {
    const {
      firstname, lastname, phone, altPhones = [],
      email, propertyAddress, city, state, notes
    } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const primary = normalize(phone);
    const props = {
      firstname, lastname, email, phone: primary,
      address: propertyAddress, city, state
      // If you have custom fields in HubSpot, map them here (e.g. property_address__c, etc.)
    };

    let contactId = await findContactByPhone(primary);
    if (!contactId) contactId = await createContact(props);
    else await updateContact(contactId, props);

    if (notes) {
      const nid = await createNote(notes);
      await associateNoteToContact(nid, contactId);
    }

    // Optionally store altPhones in a custom property; otherwise just ignore:
    // if (Array.isArray(altPhones) && altPhones.length) {
    //   await updateContact(contactId, { alt_phone_list: altPhones.map(normalize).join(';') });
    // }

    res.json({ ok: true, contactId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// 2) log_note
app.post('/tools/log_note', requireSecret, async (req, res) => {
  try {
    const { phone, contactId, text } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });

    let id = contactId;
    if (!id && phone) id = await findContactByPhone(normalize(phone));

    const nid = await createNote(text);
    if (id) await associateNoteToContact(nid, id);

    res.json({ ok: true, noteId: nid, contactId: id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// 3) set_lead_status
app.post('/tools/set_lead_status', requireSecret, async (req, res) => {
  try {
    const { phone, contactId, status, notes } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, error: 'status required' });

    let id = contactId;
    if (!id && phone) id = await findContactByPhone(normalize(phone));
    if (!id) id = await createContact({ phone: normalize(phone || '') });

    // Map to your exact HS field if different:
    await updateContact(id, { hs_lead_status: status });

    if (notes) {
      const nid = await createNote(`Lead status = ${status}. ${notes}`);
      await associateNoteToContact(nid, id);
    }

    res.json({ ok: true, contactId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// 4) schedule_followup
app.post('/tools/schedule_followup', requireSecret, async (req, res) => {
  try {
    const { phone, contactId, when, reason } = req.body || {};
    let id = contactId;
    if (!id && phone) id = await findContactByPhone(normalize(phone));

    const text = `Follow-up scheduled: ${when}${reason ? ' — ' + reason : ''}`;
    const nid = await createNote(text);
    if (id) await associateNoteToContact(nid, id);

    res.json({ ok: true, contactId: id || null, noteId: nid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// 5) mark_dnc
app.post('/tools/mark_dnc', requireSecret, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    let id = await findContactByPhone(normalize(phone));
    if (!id) id = await createContact({ phone: normalize(phone) });

    // Map to your DNC field if you use a custom one:
    await updateContact(id, { hs_lead_status: 'DNC' });
    const nid = await createNote('Contact requested DNC.');
    await associateNoteToContact(nid, id);

    res.json({ ok: true, contactId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// 6) remove_number_from_contact
app.post('/tools/remove_number_from_contact', requireSecret, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });

    const id = await findContactByPhone(normalize(phone));
    if (!id) return res.json({ ok: true, contactId: null, removed: false });

    await updateContact(id, { phone: '' });
    const nid = await createNote(`Removed wrong number: ${phone}`);
    await associateNoteToContact(nid, id);

    res.json({ ok: true, contactId: id, removed: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message });
  }
});

// 7) send_sms (optional)
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}
app.post('/tools/send_sms', requireSecret, async (req, res) => {
  try {
    if (!twilioClient) return res.status(400).json({ ok: false, error: 'twilio not configured' });
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ ok: false, error: 'to and message required' });

    const r = await twilioClient.messages.create({ to: normalize(to), from: TWILIO_NUMBER, body: message });
    res.json({ ok: true, sid: r.sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || e });
  }
});

// 8) live_transfer notifier (use Vapi native “Phone Transfer” for the actual bridge)
app.post('/tools/live_transfer', requireSecret, async (req, res) => {
  try {
    const { phone, devNumber, summary } = req.body || {};
    let smsSid = null;
    if (twilioClient && devNumber) {
      const text = `HOT LEAD: ${summary}${phone ? ` | Seller: ${phone}` : ''}`;
      const r = await twilioClient.messages.create({
        to: normalize(devNumber),
        from: TWILIO_NUMBER,
        body: text
      });
      smsSid = r.sid;
    }
    res.json({ ok: true, notified: Boolean(smsSid) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || e });
  }
});

app.get('/', (_req, res) => res.send('Vapi ↔ HubSpot bridge OK'));
app.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));
