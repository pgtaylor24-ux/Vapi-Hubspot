// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";

const app = express();

/* ---------------- CONFIG ---------------- */
const PORT = process.env.PORT || 8080;

const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";
const VAPI_ASSISTANT_ID_OUTBOUND = process.env.VAPI_ASSISTANT_ID_OUTBOUND || ""; // optional default outbound assistant id

const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET;
const STRICT_SIGNATURE = (process.env.STRICT_SIGNATURE ?? "true").toLowerCase() === "true";

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

/* ---------------- HELPERS ---------------- */
function verifyVapi(req) {
  const sig = req.header("X-Vapi-Signature");
  const legacy = req.header("X-Vapi-Secret");
  if (!VAPI_SERVER_SECRET) {
    console.warn("WARNING: VAPI_SERVER_SECRET not set; skipping signature verification.");
    return true;
  }
  return (sig && sig === VAPI_SERVER_SECRET) || (legacy && legacy === VAPI_SERVER_SECRET);
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

function stripPhone(p) {
  if (!p) return "";
  return String(p).replace(/[^\d+]/g, "");
}

/* ---------------- HUBSPOT: CONTACT HELPERS ---------------- */
async function searchContact({ phone, email }) {
  // OR logic via multiple filterGroups
  const filterGroups = [];
  if (phone) {
    filterGroups.push({ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] });
    filterGroups.push({ filters: [{ propertyName: "mobilephone", operator: "EQ", value: phone }] });
  }
  if (email) {
    filterGroups.push({ filters: [{ propertyName: "email", operator: "EQ", value: email }] });
  }

  try {
    const { data } = await hs.post(`/crm/v3/objects/contacts/search`, {
      filterGroups,
      properties: [
        "firstname","lastname","email","phone","mobilephone",
        "address","city","state","zip",
        "last_summary",
        // optional custom properties you might add later:
        "motivation","house_condition","land_details","lease_end_date",
        "timing_window","price_feel","entitlement_ok"
      ],
      limit: 1
    });
    const c = data?.results?.[0];
    return c ? { id: c.id, properties: c.properties || {} } : null;
  } catch (e) {
    console.error("HubSpot search contact error:", e?.response?.data || e.message);
    return null;
  }
}

async function updateContactProps(contactId, properties) {
  if (!contactId || !properties) return;
  try {
    await hs.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
  } catch (e) {
    console.error("HubSpot update contact error:", e?.response?.data || e.message);
  }
}

/* ---------------- HUBSPOT: CORE OPS ---------------- */
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
    email, phone, firstname, lastname, lifecyclestage, source,
    propertyAddress, propertyCity, propertyState, propertyZip
  } = args || {};

  const properties = {};
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (lifecyclestage) properties.lifecyclestage = lifecyclestage;
  if (source) properties.source = source;

  // map to default HS props (adjust if you use custom ones)
  if (propertyAddress) properties.address = propertyAddress;
  if (propertyCity) properties.city = propertyCity;
  if (propertyState) properties.state = propertyState;
  if (propertyZip) properties.zip = propertyZip;

  let contactId = await findContactIdByEmail(email);
  if (!contactId && phone) {
    const s = await searchContact({ phone });
    contactId = s?.id || null;
  }

  if (contactId) {
    await updateContactProps(contactId, properties);
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
      await hs.put(`/crm/v3/objects/notes/${noteId}/associations/contact/${contact_id}/note_to_contact`);
    } catch (e) {
      console.error("Associate note->contact failed:", e?.response?.data || e.message);
    }

    // --- Memory: also update contact.last_summary with a one-liner from this note
    const firstLine = String(note || "").split(/\r?\n/)[0].trim();
    const compact = firstLine.length > 240 ? firstLine.slice(0, 237) + "..." : firstLine;
    if (compact) {
      await updateContactProps(contact_id, { last_summary: compact });
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

/**
 * Core webhook:
 * - type === "assistant-request"  => return assistant override + variables (memory injection)
 * - else handle tool calls (message.toolCalls) => return tool results
 */
app.post("/webhook", async (req, res) => {
  try {
    const okSig = verifyVapi(req);
    if (!okSig) {
      console.warn("Invalid signature");
      if (STRICT_SIGNATURE) return res.status(403).json({ error: "Invalid signature" });
    }

    const body = req.body || {};
    const type = body.type || body?.message?.type || "";
    const message = body.message || body; // for tool calls fallback
    ensureAssistantOk(message);

    /* ---------- 1) MEMORY INJECTION ON assistant-request ---------- */
    if (type === "assistant-request") {
      // Pull caller identity from request (Vapi sends one of these)
      const phone =
        body?.call?.customer?.number ||
        body?.phoneNumber?.number ||
        body?.customer?.number ||
        "";
      const email =
        body?.call?.customer?.email ||
        body?.customer?.email ||
        "";

      let variables = {};
      let assistantId = VAPI_ASSISTANT_ID_OUTBOUND || VAPI_ASSISTANT_ID || undefined;

      if (HUBSPOT_TOKEN && (phone || email)) {
        const stripped = stripPhone(phone);
        const found = await searchContact({ phone: stripped, email });
        const p = found?.properties || {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
        const propertyAddress = p.address || "";
        const city = p.city || "";
        const state = p.state || "";
        const last_summary = p.last_summary || "";
        variables = {
          name: name || undefined,
          propertyAddress: propertyAddress || undefined,
          city: city || undefined,
          state: state || undefined,
          last_summary: last_summary || undefined
        };
      }

      // Respond with assistant override: you can send assistantId AND variables
      return res.json({
        assistantId: assistantId, // optional; omit if you want Vapi to use the one that initiated the call
        variables
      });
    }

    /* ---------- 2) TOOL CALLS (default path) ---------- */
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

          // graceful stubs so the model never crashes:
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

    return res.json({ results });
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
