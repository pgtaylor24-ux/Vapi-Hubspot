import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

// --- Config ---
const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET; // must match Assistant → Server URL → Secret
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const DEFAULT_PIPELINE = process.env.HUBSPOT_PIPELINE || "default";
const DEFAULT_DEALSTAGE = process.env.HUBSPOT_DEALSTAGE || "appointmentscheduled";

if (!VAPI_SERVER_SECRET) {
  console.warn("WARNING: VAPI_SERVER_SECRET not set");
}
if (!HUBSPOT_TOKEN) {
  console.warn("WARNING: HUBSPOT_TOKEN not set");
}

// --- Verify Vapi signature ---
// Vapi sends X-Vapi-Signature: YOUR_SECRET (simple shared-secret scheme)
function verifyVapi(req) {
  const sig = req.header("X-Vapi-Signature");
  return !!sig && sig === VAPI_SERVER_SECRET;
}

// --- HubSpot helpers ---
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
});

async function upsertContact({ email, phone, firstname, lastname, lifecyclestage, source }) {
  // If email present, try "create or update by email". If not, create bare contact.
  // 1) Try find by email
  let contactId = null;
  if (email) {
    try {
      const r = await hs.get(`/crm/v3/objects/contacts`, {
        params: { limit: 1, properties: "email", q: email }
      });
      const hit = r.data.results?.find(c => (c.properties?.email || "").toLowerCase() === email.toLowerCase());
      if (hit) contactId = hit.id;
    } catch (_) {}
  }

  const props = {};
  if (email) props.email = email;
  if (phone) props.phone = phone;
  if (firstname) props.firstname = firstname;
  if (lastname) props.lastname = lastname;
  if (lifecyclestage) props.lifecyclestage = lifecyclestage;
  if (source) props.source = source;

  if (contactId) {
    await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties: props });
    return { id: contactId, updated: true };
  } else {
    const created = await hs.post(`/crm/v3/objects/contacts`, { properties: props });
    return { id: created.data.id, created: true };
  }
}

async function createDeal({ dealname, amount, pipeline, dealstage, close_date, associated_contact_id }) {
  const props = {
    dealname,
    pipeline: pipeline || DEFAULT_PIPELINE,
    dealstage: dealstage || DEFAULT_DEALSTAGE
  };
  if (amount != null) props.amount = String(amount);
  if (close_date) props.closedate = close_date;

  const deal = await hs.post(`/crm/v3/objects/deals`, { properties: props });
  const dealId = deal.data.id;

  if (associated_contact_id) {
    // Associate to contact
    await hs.put(`/crm/v4/objects/deals/${dealId}/associations/contacts/${associated_contact_id}/deal_to_contact`, [
      { type: "deal_to_contact" }
    ]);
  }

  return { id: dealId };
}

async function createNote({ contact_id, note }) {
  // Create engagement note and associate to contact if provided
  const noteObj = await hs.post(`/crm/v3/objects/notes`, {
    properties: { hs_note_body: note }
  });
  const noteId = noteObj.data.id;

  if (contact_id) {
    await hs.put(`/crm/v4/objects/notes/${noteId}/associations/contacts/${contact_id}/note_to_contact`, [
      { type: "note_to_contact" }
    ]);
  }

  return { id: noteId };
}

// --- Health check ---
app.get("/", (_req, res) => res.send("Vapi ↔ HubSpot bridge is up"));

// --- Vapi webhook ---
// Set this path as Assistant → Server URL
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyVapi(req)) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    const body = req.body;
    // Vapi sends many message types; we care when there are tool calls
    // See: Server Message schema & assistant hooks docs
    const message = body?.message || body; // be defensive
    const toolCalls = message?.toolCalls || [];

    // Collect results per tool call (if any)
    const results = [];

    for (const call of toolCalls) {
      const { function: fn, id: callId } = call || {};
      const name = fn?.name;
      const args = fn?.arguments || {};
      let data;

      switch (name) {
        case "create_or_update_hubspot_contact":
          data = await upsertContact(args);
          break;
        case "create_hubspot_deal":
          data = await createDeal(args);
          break;
        case "log_hubspot_note":
          data = await createNote(args);
          break;
        case "schedule_meeting_placeholder":
          data = {
            scheduled: true,
            url: "https://calendly.com/pg-taylorrealestategroups/30min",
            info: "Placeholder meeting created (swap for real scheduling later)."
          };
          break;
        default:
          data = { error: `Unknown tool: ${name}` };
      }

      results.push({
        toolCallId: callId,
        result: data
      });
    }

    // You should always return 200 with JSON: { results: [...] }
    // This allows Ellie to see the tool results mid-conversation.
    return res.json({ results });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ results: [{ error: "Server error", detail: String(err) }] });
  }
});

// --- Start ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server listening on :${port}`));
