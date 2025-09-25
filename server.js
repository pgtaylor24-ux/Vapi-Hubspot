// server.js (CommonJS, ready for Render/Node >=16)
// - PATCH Vapi assistant on boot to enable barge-in / streaming
// - Assistant-request webhook injects HubSpot context by caller phone
// - Minimal, robust, and easy to extend

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const dotenv = require("dotenv");
dotenv.config();

const {
  PORT = 8080,
  VAPI_API_KEY,
  VAPI_ASSISTANT_ID,
  HUBSPOT_ACCESS_TOKEN
} = process.env;

if (!VAPI_API_KEY) {
  console.error("❌ Missing VAPI_API_KEY in env.");
  process.exit(1);
}
if (!VAPI_ASSISTANT_ID) {
  console.error("❌ Missing VAPI_ASSISTANT_ID in env.");
  process.exit(1);
}
if (!HUBSPOT_ACCESS_TOKEN) {
  console.warn("⚠️  Missing HUBSPOT_ACCESS_TOKEN — HubSpot lookups will be skipped.");
}

const app = express();
app.use(bodyParser.json());

// ---------------- Assistant overlay (applied via PATCH) ----------------
const assistantOverlay = {
  bargeIn: {
    enabled: true,
    minCallerSpeechMs: 120,
    resumeAfterInterruptMs: 80
  },
  transcription: {
    provider: "openai",                 // or "deepgram"
    model: "gpt-4o-mini-transcribe",
    partialResults: true,
    punctuate: true,
    smartFormat: true,
    noiseReduction: true,
    endpointing: {
      silenceDurationMs: 350,
      maxSpeechMs: 15000
    }
  },
  vad: {
    enabled: true,
    aggressiveness: 3,
    minSpeechMs: 100,
    postSpeechMs: 120,
    preSpeechMs: 40
  },
  latency: { mode: "low" },
  tts: {
    provider: "elevenlabs",
    interruptOnVoice: true,             // critical for instant cutoffs
    maxUtteranceMs: 3500,
    normalizePunctuation: true
  },
  input: {
    enableInputStreaming: true,
    noInputTimeoutMs: 9000,
    maxTurnMs: 30000
  },
  policies: {
    allowOvertalk: true,
    suppressFillers: true,
    maxSentencesPerReply: 2
  },
  // Short, permission-based opener (optional to keep here; you can remove if set in Vapi)
  firstMessage:
    "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?",
  prompt:
    "You are Alex, a concise, friendly acquisitions agent for Taylor Real Estate Group. " +
    "Openings under 7 seconds. Stop speaking the instant the caller starts talking. " +
    "Keep replies short (max 2 sentences), one idea per reply. If bad time, offer to reschedule."
};

async function patchAssistantOverlay() {
  const url = `https://api.vapi.ai/v1/assistants/${encodeURIComponent(VAPI_ASSISTANT_ID)}`;
  const headers = {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    "Content-Type": "application/json"
  };
  const body = { assistant: assistantOverlay };

  const { data } = await axios.patch(url, body, { headers, timeout: 15000 });
  return data;
}

// ---------------- HubSpot helpers ----------------
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: HUBSPOT_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}` }
    : {},
  timeout: 15000
});

/**
 * Normalize E.164 or raw PSTN numbers (keep digits and '+')
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  // If it already looks like E.164 (+1...), keep it.
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;
  // Otherwise, strip non-digits, prepend +1 if US-length
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/**
 * Find a HubSpot contact by phone (tries query-based search).
 * Falls back to last-contacted if multiple matches.
 */
async function findContactByPhone(phoneE164) {
  if (!HUBSPOT_ACCESS_TOKEN || !phoneE164) return null;

  try {
    // HubSpot Search API (simple q= search)
    const url = `/crm/v3/objects/contacts/search`;
    const body = {
      q: phoneE164,
      properties: [
        "firstname",
        "lastname",
        "email",
        "phone",
        "mobilephone",
        "hs_lead_status",
        "lifecyclestage",
        "hs_lastcontacted",
        "lastmodifieddate",
        "city",
        "state",
        "zip",
        "address"
      ],
      limit: 5,
      sort: [
        { propertyName: "hs_lastcontacted", direction: "DESCENDING" }
      ]
    };

    const { data } = await hs.post(url, body);
    const results = data?.results || [];
    if (!results.length) return null;

    // Pick top result (most recently contacted)
    const top = results[0];
    return {
      id: top.id,
      properties: top.properties || {}
    };
  } catch (err) {
    console.warn("HubSpot search error:", err?.response?.data || err.message);
    return null;
  }
}

/**
 * Optional: get deals associated with a contact (basic snapshot).
 */
async function getDealsForContact(contactId) {
  if (!HUBSPOT_ACCESS_TOKEN || !contactId) return [];

  try {
    // list deal associations (contact -> deals)
    const assocUrl = `/crm/v4/objects/contacts/${contactId}/associations/deals`;
    const { data } = await hs.get(assocUrl);
    const ids = (data?.results || []).map(r => r.toObjectId).slice(0, 5);
    if (!ids.length) return [];

    const dealUrl = `/crm/v3/objects/deals/batch/read`;
    const body = {
      properties: ["dealname", "amount", "dealstage", "closedate", "pipeline"],
      inputs: ids.map(id => ({ id }))
    };
    const resp = await hs.post(dealUrl, body);
    return (resp?.data?.results || []).map(d => ({
      id: d.id,
      ...d.properties
    }));
  } catch (err) {
    console.warn("HubSpot deals error:", err?.response?.data || err.message);
    return [];
  }
}

/**
 * Build a short one-liner last_summary from HubSpot fields (safe + concise).
 */
function buildLastSummary(contact, deals) {
  if (!contact) return null;
  const p = contact.properties || {};
  const name =
    [p.firstname, p.lastname].filter(Boolean).join(" ") || "the owner";
  const status = p.hs_lead_status ? `status ${p.hs_lead_status}` : null;
  const stage = p.lifecyclestage ? `stage ${p.lifecyclestage}` : null;

  const lastContact =
    p.hs_lastcontacted
      ? new Date(p.hs_lastcontacted).toLocaleDateString()
      : null;

  const dealSnippet = deals && deals.length
    ? `Recent deal: ${deals[0].dealname || "—"} (${deals[0].dealstage || "stage unknown"})`
    : null;

  const bits = [];
  bits.push(`Spoke with ${name}${lastContact ? ` (last contact ${lastContact})` : ""}.`);
  if (status || stage) bits.push(`CRM ${[status, stage].filter(Boolean).join(", ")}.`);
  if (dealSnippet) bits.push(dealSnippet);
  return bits.join(" ");
}

// ---------------- Routes ----------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Force re-apply assistant overlay any time
app.post("/admin/update-assistant", async (_req, res) => {
  try {
    const data = await patchAssistantOverlay();
    res.json({ ok: true, assistant_id: VAPI_ASSISTANT_ID, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err?.response?.data || err.message) });
  }
});

// Quick local test of HubSpot search: GET /admin/test-hubspot?phone=+16158397260
app.get("/admin/test-hubspot", async (req, res) => {
  try {
    const raw = req.query.phone;
    const phone = normalizePhone(raw);
    if (!phone) {
      return res.status(400).json({ ok: false, error: "Provide ?phone=E164 or raw." });
    }
    const contact = await findContactByPhone(phone);
    const deals = contact ? await getDealsForContact(contact.id) : [];
    const last_summary = buildLastSummary(contact, deals) || "No prior context in CRM.";
    res.json({ ok: true, phone, contact, deals, last_summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.response?.data || err.message) });
  }
});

// ----- Vapi Assistant Request Webhook -----
// Configure in Vapi: Assistant → Webhooks → Assistant Request
// Vapi will POST here BEFORE the call starts. We return assistant overrides + variables.
app.post("/webhooks/vapi/assistant-request", async (req, res) => {
  try {
    // Vapi payload shape can vary—collect best-effort fields.
    const metadata = req.body?.metadata || {};
    const callerNumber =
      req.body?.caller?.number ||
      req.body?.from ||
      metadata?.caller_number ||
      null;

    const property_street =
      metadata?.property_street ||
      req.body?.variables?.property_street ||
      "your property";

    let last_summary = "No prior context in CRM.";
    if (HUBSPOT_ACCESS_TOKEN && callerNumber) {
      const phone = normalizePhone(callerNumber);
      const contact = await findContactByPhone(phone);
      const deals = contact ? await getDealsForContact(contact.id) : [];
      const built = buildLastSummary(contact, deals);
      if (built) last_summary = built;
    }

    // Optionally, keep responses extra concise on first turn
    const assistantOverrides = {
      variables: {
        property_street,
        last_summary
      },
      // You can tweak the firstMessage per-call without losing the overlay set via PATCH
      firstMessage:
        "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?"
    };

    return res.json({ ok: true, assistant: assistantOverrides });
  } catch (err) {
    console.error("assistant-request webhook error:", err);
    // Fail open: let Vapi proceed without overrides if our webhook has trouble
    return res.json({ ok: true });
  }
});

// ---------------- Boot: apply overlay now ----------------
(async function boot() {
  try {
    console.log("⏳ Applying Vapi barge-in/streaming overlay …");
    const data = await patchAssistantOverlay();
    console.log("✅ Overlay applied to assistant:", {
      id: VAPI_ASSISTANT_ID,
      name: data?.assistant?.name || "(unnamed)"
    });
  } catch (err) {
    console.error("❌ Failed to apply overlay on boot:", err?.response?.data || err.message);
  }
})();

app.listen(PORT, () => {
  console.log(`🚀 server listening on http://localhost:${PORT}`);
});
