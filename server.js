// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();

/* ---------------- CONFIG ---------------- */
const PORT = process.env.PORT || 8080;

// Optional: lock to your assistant ID (warn-only)
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || ""; // "0d1f5365-a01e-4af4-b240-0fd0db2631ae"

// Your Vapi Assistant → Advanced → Server URL → Secret (leave HTTP Headers blank)
const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET;

// Set STRICT_SIGNATURE=false while debugging if Vapi says "can't connect to hook"
const STRICT_SIGNATURE = (process.env.STRICT_SIGNATURE ?? "true").toLowerCase() === "true";

// HubSpot Private App token (contacts/deals/notes write scopes)
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

/* ---------------- HELPERS ---------------- */
function verifyVapi(req) {
  // Prefer X-Vapi-Signature (Secret field). Also accept X-Vapi-Secret (header credential).
  const hSig = req.header("X-Vapi-Signature");
  const hLegacy = req.header("X-Vapi-Secret");
  if (!VAPI_SERVER_SECRET) {
    console.warn("WARNING: VAPI_SERVER_SECRET not set; skipping signature verification.");
    return true; // flip to false to hard-enforce even without env var
  }
  return (hSig && hSig === VAPI_SERVER_SECRET) || (hLegacy && hLegacy === VAPI_SERVER_SECRET);
}

function ensureAssistantOk(message) {
  if (!VAPI_ASSISTANT_ID) return true;
  const incoming = message?.assistantId || message?.assistant_id || "";
  if (incoming && incoming !== VAPI_ASSISTANT_ID) {
    console.warn(`AssistantId mismatch. Expected ${VAPI_ASSISTANT_ID}, got ${incoming}`);
  }
  return true; // warn-only
}

const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  timeout: 15000
});

/* ---------------- HUBSPOT HELPERS ---------------- */

async function findContactIdByEmail(email) {
  if (!email) return null;
  try {
    const { data } = await hs.post(`/crm/v3/objects/contacts/search`, {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"],
      limit: 1
    });
    return data?.results?.[0]?.id || null;
  } catch (e) {
    console.error("HubSpot search contact error:", e?.response?.data || e.message);
    return null;
  }
}

async function upsertContact(args) {
  const {
    email,
    phone,
    firstname,
    lastname,
    lifecyclestage,
    source,
    propertyAddress,
    propertyCity,
    propertyState,
    propertyZip
  } = args || {};

  const properties = {};
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (lifecyclestage) properties.lifecyclestage = lifecyclestage;
  if (source) properties.source = source;

  // map optional address fields to default HS props (adjust if you use custom ones)
  if (propertyAddress) properties.address = propertyAddress;
  if (propertyCity) properties.city = propertyCity;
  if (propertyState) properties.state = propertyState;
  if (propertyZip) properties.zip = propertyZip;

  let contactId = await findContactIdByEmail(email);

  if (contactId) {
    await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
    return { id: contactId, updated: true };
  } else {
    const { data } = await hs.post(`/crm/v3/objects/contacts`, { properties });
    return { id: data.id, created: true };
  }
}

async function createDeal(args) {
  const { dealname, amount, pipeline, dealstage, close_date, associated_contact_id } = args || {};
  const props = { dealname };
  if (amount != null) props.amount = String(amount);
  if (pipeline) props.pipeline = pipeline;
  if (dealstage) props.dealstage = dealstage;
  if (close_date) props.closedate = close_date;

  const { data } = await hs.post(`/crm/v3/objects/deals`, { properties: props });
  const dealId = data.id;

  if (associated_contact_id) {
    try {
      // v4 default association: deal -> contact
      await hs.put(`/crm/v4/objects/deal/${dealId}/associations/default/contact/${associated_contact_id}`);
    } catch (e) {
      console.error("Associate deal->contact failed:", e?.response?.data || e.message);
    }
  }

  return { id: dealId };
}

async function createNote(args) {
  const { contact_id, note } = args || {};
  const tsIso = new Date().toISOString();

  const { data } = await hs.post(`/crm/v3/objects/notes`, {
    properties: { hs_timestamp: tsIso, hs_note_body: note }
  });
  const noteId = data.id;

  if (contact_id) {
    try {
      // v3 association type id
      await hs.put(`/crm/v3/objects/notes/${noteId}/associations/contact/${contact_id}/note_to_contact`);
    } catch (e) {
      console.error("Associate note->contact failed:", e?.response?.data || e.message);
    }
  }

  return { id: noteId };
}

/* ---------------- ROUTES ---------------- */

app.get("/", (_req, res) => res.status(200).send("Vapi ↔ HubSpot bridge is up"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    assistantIdEnforced: !!VAPI_ASSISTANT_ID,
    hasHubSpotToken: !!HUBSPOT_TOKEN,
    signatureRequired: !!VAPI_SERVER_SECRET,
    strictSignature: STRICT_SIGNATURE,
    now: new Date().toISOString()
  });
});

app.post("/webhook", async (req, res) => {
  try {
    // Helpful debug log (safe; no bodies)
    console.log("POST /webhook", {
      headers: {
        hasSig: !!req.header("X-Vapi-Signature"),
        hasLegacy: !!req.header("X-Vapi-Secret"),
        contentType: req.header("content-type")
      }
    });

    const okSig = verifyVapi(req);
    if (!okSig) {
      console.warn("Invalid signature");
      if (STRICT_SIGNATURE) {
        return res.status(403).json({ error: "Invalid signature" });
      } else {
        // Soft-fail to keep Vapi “connected” during setup
        return res.status(200).json({ results: [{ error: "Invalid signature" }] });
      }
    }

    const message = req.body?.message || req.body || {};
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
          // Canonical names + aliases to match your prompt/tools
          case "create_or_update_hubspot_contact":
          case "create_or_update_contact":
            result = await upsertContact(args);
            break;

          case "create_hubspot_deal":
          case "create_deal":
            result = await createDeal(args);
            break;

          case "log_hubspot_note":
          case "log_note":
            result = await createNote(args);
            break;

          case "schedule_meeting_placeholder":
          case "schedule_followup":
            result = {
              scheduled: true,
              url: "https://calendly.com/pg-taylorrealestategroups/30min",
              info: "Placeholder; replace with real scheduler later."
            };
            break;

          // Not wired yet—don’t crash the call
          case "set_lead_status":
          case "mark_dnc":
          case "remove_number_from_contact":
          case "live_transfer":
          case "send_sms":
            result = { ok: true, info: `${name} not wired yet; ignoring.` };
            break;

          default:
            result = { error: `Unknown tool: ${name}` };
        }
      } catch (e) {
        console.error(`Tool ${name} failed:`, e?.response?.data || e.message);
        result = { error: `Tool ${name} failed`, detail: e?.response?.data || e.message };
      }

      results.push({ toolCallId: callId, result });
    }

    return res.json({ results }); // Always 200 with results array
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
    return res.status(200).json({ results: [{ error: "Server error", detail: String(err.message || err) }] });
  }
});

/* ---------------- START ---------------- */
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  if (!VAPI_SERVER_SECRET) console.warn("WARNING: VAPI_SERVER_SECRET not set");
  if (!HUBSPOT_TOKEN) console.warn("WARNING: HUBSPOT_TOKEN not set");
  if (VAPI_ASSISTANT_ID) console.log(`Assistant ID check enabled for: ${VAPI_ASSISTANT_ID}`);
});
