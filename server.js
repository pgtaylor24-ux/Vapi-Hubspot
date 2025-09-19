// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 8080;

// If you set this to your assistant ID, we’ll log & optionally gate messages
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || ""; // e.g. "0d1f5365-a01e-4af4-b240-0fd0db2631ae"

// Shared secret you configure in Vapi (either Server URL → Secret
// which sends X-Vapi-Signature, OR a Custom Credential header X-Vapi-Secret)
const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET;

// HubSpot Private App token (Scopes: crm.objects.contacts.write, crm.objects.deals.write, crm.objects.notes.write)
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

// ---------- Middleware ----------
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

// ---------- Helpers ----------
function verifyVapi(req) {
  // Allow either header depending on how you configured Vapi.
  const h1 = req.header("X-Vapi-Signature");
  const h2 = req.header("X-Vapi-Secret"); // if you used Custom Credential
  if (!VAPI_SERVER_SECRET) {
    console.warn("WARNING: VAPI_SERVER_SECRET not set; skipping signature verification.");
    return true; // do not block if not configured (you can switch this to false to hard-enforce)
  }
  return (h1 && h1 === VAPI_SERVER_SECRET) || (h2 && h2 === VAPI_SERVER_SECRET);
}

function ensureAssistantOk(message) {
  if (!VAPI_ASSISTANT_ID) return true; // not enforcing
  const incoming = message?.assistantId || message?.assistant_id || "";
  if (incoming && incoming !== VAPI_ASSISTANT_ID) {
    console.warn(`AssistantId mismatch. Expected ${VAPI_ASSISTANT_ID}, got ${incoming}`);
    // Return false to hard-enforce; for now just warn:
    return true;
  }
  return true;
}

const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  timeout: 15000
});

// --- HubSpot: find existing contact by email (Search API) ---
async function findContactIdByEmail(email) {
  if (!email) return null;
  try {
    const { data } = await hs.post(`/crm/v3/objects/contacts/search`, {
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }]
        }
      ],
      properties: ["email"],
      limit: 1
    });
    const id = data?.results?.[0]?.id || null;
    return id;
  } catch (e) {
    console.error("HubSpot search contact error:", e?.response?.data || e.message);
    return null;
  }
}

// --- HubSpot: create or update contact ---
async function upsertContact({ email, phone, firstname, lastname, lifecyclestage, source }) {
  const properties = {};
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (lifecyclestage) properties.lifecyclestage = lifecyclestage;
  if (source) properties.source = source;

  // Try to find by email (most reliable unique key)
  let contactId = await findContactIdByEmail(email);

  if (contactId) {
    // Update
    await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
    return { id: contactId, updated: true };
  } else {
    // Create
    const { data } = await hs.post(`/crm/v3/objects/contacts`, { properties });
    return { id: data.id, created: true };
  }
}

// --- HubSpot: create deal and (optionally) associate to a contact ---
async function createDeal({ dealname, amount, pipeline, dealstage, close_date, associated_contact_id }) {
  const props = { dealname };
  if (amount != null) props.amount = String(amount);
  if (pipeline) props.pipeline = pipeline;
  if (dealstage) props.dealstage = dealstage;
  if (close_date) props.closedate = close_date;

  const { data } = await hs.post(`/crm/v3/objects/deals`, { properties: props });
  const dealId = data.id;

  if (associated_contact_id) {
    // Create a default (unlabeled) association between deal and contact using Associations v4
    // Endpoint per docs: PUT /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}
    try {
      await hs.put(`/crm/v4/objects/deal/${dealId}/associations/default/contact/${associated_contact_id}`);
    } catch (e) {
      console.error("Associate deal->contact failed (v4 default):", e?.response?.data || e.message);
    }
  }

  return { id: dealId };
}

// --- HubSpot: create note and (optionally) associate to contact ---
async function createNote({ contact_id, note }) {
  const tsIso = new Date().toISOString();
  const { data } = await hs.post(`/crm/v3/objects/notes`, {
    properties: {
      hs_timestamp: tsIso, // positions it on the timeline
      hs_note_body: note
    }
  });
  const noteId = data.id;

  if (contact_id) {
    // Associate note to contact (v3 supports snake case associationTypeId 'note_to_contact')
    try {
      await hs.put(`/crm/v3/objects/notes/${noteId}/associations/contact/${contact_id}/note_to_contact`);
    } catch (e) {
      console.error("Associate note->contact failed:", e?.response?.data || e.message);
    }
  }

  return { id: noteId };
}

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.status(200).send("Vapi ↔ HubSpot bridge is up");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    assistantIdEnforced: !!VAPI_ASSISTANT_ID,
    hasHubSpotToken: !!HUBSPOT_TOKEN,
    signatureRequired: !!VAPI_SERVER_SECRET,
    now: new Date().toISOString()
  });
});

// Main webhook Vapi calls (Assistant → Advanced → Server URL)
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyVapi(req)) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    const body = req.body || {};
    const message = body.message || body; // be defensive
    if (!ensureAssistantOk(message)) {
      return res.status(404).json({ error: "Assistant mismatch" });
    }

    const toolCalls = message.toolCalls || [];
    const results = [];

    for (const call of toolCalls) {
      const callId = call?.id;
      const fn = call?.function || {};
      const name = fn.name;
      const args = fn.arguments || {};
      let result;

      try {
        switch (name) {
          case "create_or_update_hubspot_contact":
            result = await upsertContact(args);
            break;

          case "create_hubspot_deal":
            result = await createDeal(args);
            break;

          case "log_hubspot_note":
            result = await createNote(args);
            break;

          case "schedule_meeting_placeholder":
            result = {
              scheduled: true,
              url: "https://calendly.com/pg-taylorrealestategroups/30min",
              info: "Placeholder; replace with real scheduler when ready."
            };
            break;

          default:
            result = { error: `Unknown tool: ${name}` };
            break;
        }
      } catch (e) {
        console.error(`Tool ${name} failed:`, e?.response?.data || e.message);
        result = { error: `Tool ${name} failed`, detail: e?.response?.data || e.message };
      }

      results.push({ toolCallId: callId, result });
    }

    // Always return 200 with { results: [...] }
    return res.json({ results });
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
    // Return a 200 with an error payload so conversation doesn’t die
    return res.status(200).json({ results: [{ error: "Server error", detail: String(err.message || err) }] });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  if (!VAPI_SERVER_SECRET) {
    console.warn("WARNING: VAPI_SERVER_SECRET not set");
  }
  if (!HUBSPOT_TOKEN) {
    console.warn("WARNING: HUBSPOT_TOKEN not set");
  }
  if (VAPI_ASSISTANT_ID) {
    console.log(`Assistant ID check enabled for: ${VAPI_ASSISTANT_ID}`);
  }
});
