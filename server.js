// server.js (ESM, works with "type": "module")
// - Patches Vapi assistant (barge-in, partial ASR, VAD, low-latency) on boot and via /admin/update-assistant
// - Assistant-request webhook uses HubSpot to inject {{last_summary}} and {{property_street}} per call

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const {
  PORT = process.env.PORT || 8080,
  VAPI_API_KEY,
  VAPI_ASSISTANT_ID,
  HUBSPOT_ACCESS_TOKEN
} = process.env;

// Early env validation
if (!VAPI_API_KEY) {
  console.error("❌ Missing VAPI_API_KEY in env.");
  process.exit(1);
}
if (!VAPI_ASSISTANT_ID) {
  console.error("❌ Missing VAPI_ASSISTANT_ID in env.");
  process.exit(1);
}
if (!HUBSPOT_ACCESS_TOKEN) {
  console.warn("⚠️  HUBSPOT_ACCESS_TOKEN not set — CRM context will be limited.");
}

const app = express();
app.use(bodyParser.json());

// ---------------- Assistant overlay to enforce real-time behavior ----------------
const assistantOverlay = {
  bargeIn: {
    enabled: true,
    minCallerSpeechMs: 120,
    resumeAfterInterruptMs: 80
  },
  transcription: {
    provider: "openai",                 // or "deepgram"
    model: "gpt-4o-mini-transcribe",    // streaming ASR
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
    provider: "elevenlabs",             // or your current TTS provider
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
  // Optional opener + prompt (remove if you prefer to manage inside Vapi)
  firstMessage:
    "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?",
  prompt:
    "You are Alex, a concise, friendly acquisitions agent for Taylor Real Estate Group. " +
    "Openings under 7 seconds. Stop speaking the instant the caller starts talking. " +
    "Keep replies short (max 2 sentences), one idea per reply. If bad time, offer to reschedule."
};

// --- PATCH your assistant to apply overlay
async function patchAssistantOverlay() {
  const url = `https://api.vapi.ai/v1/assistants/${encodeURIComponent(VAPI_ASSISTANT_ID)}`;
  const headers = {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    "Content-Type": "application/json"
  };
  const body = { assistant: assistantOverlay };
  const { data } = await axios.patch(url, body, { headers, timeout: 20000 });
  return data;
}

// ---------------- HubSpot helpers ----------------
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: HUBSPOT_ACCESS_TOKEN
    ? { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}` }
    : {},
  timeout: 20000
});

function normalizePhone(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^\+\d{7,15}$/.test(trimmed)) return trimmed;      // already E.164
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;        // assume US
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

async function findContactByPhone(phoneE164) {
  if (!HUBSPOT_ACCESS_TOKEN || !phoneE164) return null;
  try {
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
      sort: [{ propertyName: "hs_lastcontacted", direction: "DESCENDING" }]
    };
    const { data } = await hs.post(url, body);
    const results = data?.results || [];
    if (!results.length) return null;
    const top = results[0];
    return { id: top.id, properties: top.properties || {} };
  } catch (err) {
    console.warn("HubSpot search error:", err?.response?.data || err.message);
    return null;
  }
}

async function getDealsForContact(contactId) {
  if (!HUBSPOT_ACCESS_TOKEN || !contactId) return [];
  try {
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

function buildLastSummary(contact, deals) {
  if (!contact) return null;
  const p = contact.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || "the owner";
  const status = p.hs_lead_status ? `status ${p.hs_lead_status}` : null;
  const stage = p.lifecyclestage ? `stage ${p.lifecyclestage}` : null;
  const lastContact = p.hs_lastcontacted
    ? new Date(p.hs_lastcontacted).toLocaleDateString()
    : null;
  const dealSnippet =
    deals && deals.length
      ? `Recent deal: ${deals[0].dealname || "—"} (${deals[0].dealstage || "stage unknown"})`
      : null;

  const bits = [];
  bits.push(`Spoke with ${name}${lastContact ? ` (last contact ${lastContact})` : ""}.`);
  if (status || stage) bits.push(`CRM ${[status, stage].filter(Boolean).join(", ")}.`);
  if (dealSnippet) bits.push(dealSnippet);
  return bits.join(" ");
}

// ---------------- Routes ----------------
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post("/admin/update-assistant", async (_req, res) => {
  try {
    const data = await patchAssistantOverlay();
    res.json({ ok: true, assistant_id: VAPI_ASSISTANT_ID, data });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ ok: false, error: String(err?.response?.data || err.message) });
  }
});

app.get("/admin/test-hubspot", async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone) return res.status(400).json({ ok: false, error: "Provide ?phone=E164 or raw." });
    const contact = await findContactByPhone(phone);
    const deals = contact ? await getDealsForContact(contact.id) : [];
    const last_summary = buildLastSummary(contact, deals) || "No prior context in CRM.";
    res.json({ ok: true, phone, contact, deals, last_summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.response?.data || err.message) });
  }
});

// ---- Vapi Assistant Request Webhook ----
// Configure this in Vapi: Assistant → Webhooks → Assistant Request (POST)
app.post("/webhooks/vapi/assistant-request", async (req, res) => {
  try {
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

    // Per-call override (keeps overlay settings applied by PATCH)
    const assistantOverrides = {
      variables: { property_street, last_summary },
      firstMessage:
        "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?"
    };

    return res.json({ ok: true, assistant: assistantOverrides });
  } catch (err) {
    console.error("assistant-request webhook error:", err);
    return res.json({ ok: true }); // fail-open
  }
});

// -------------- Boot: apply overlay now --------------
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
  console.log(`🚀 server listening on http://0.0.0.0:${PORT}`);
});
