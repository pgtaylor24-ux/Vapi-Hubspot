// server.js (ESM) — Vapi barge-in/streaming overlay + HubSpot enrichment
// Works with "type": "module" on Render

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const {
  PORT = process.env.PORT || 8080,
  VAPI_API_KEY,
  VAPI_ASSISTANT_ID,
  VAPI_BASE_URL = "https://api.vapi.ai",
  HUBSPOT_ACCESS_TOKEN
} = process.env;

// ---- Early env validation
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

// ---------------- Real-time overlay settings (barge-in, ASR, VAD, low-latency) ----------------
const overlay = {
  bargeIn: { enabled: true, minCallerSpeechMs: 120, resumeAfterInterruptMs: 80 },
  transcription: {
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    partialResults: true,
    punctuate: true,
    smartFormat: true,
    noiseReduction: true,
    endpointing: { silenceDurationMs: 350, maxSpeechMs: 15000 }
  },
  vad: { enabled: true, aggressiveness: 3, minSpeechMs: 100, postSpeechMs: 120, preSpeechMs: 40 },
  latency: { mode: "low" },
  tts: { provider: "elevenlabs", interruptOnVoice: true, maxUtteranceMs: 3500, normalizePunctuation: true },
  input: { enableInputStreaming: true, noInputTimeoutMs: 9000, maxTurnMs: 30000 },
  policies: { allowOvertalk: true, suppressFillers: true, maxSentencesPerReply: 2 },
  firstMessage:
    "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?",
  prompt:
    "You are Alex, a concise, friendly acquisitions agent for Taylor Real Estate Group. " +
    "Openings under 7 seconds. Stop speaking the instant the caller starts talking. " +
    "Keep replies short (max 2 sentences), one idea per reply. If bad time, offer to reschedule."
};

// ---------------- Vapi: update assistant helper (PATCH → PUT fallback) ----------------
function decorateVapiError(method, url, err) {
  return new Error(
    JSON.stringify(
      { method, url, status: err?.response?.status, data: err?.response?.data || err.message },
      null,
      2
    )
  );
}

async function patchAssistantOverlay() {
  const url = `${VAPI_BASE_URL}/v1/assistants/${encodeURIComponent(VAPI_ASSISTANT_ID)}`;
  const headers = { Authorization: `Bearer ${VAPI_API_KEY}`, "Content-Type": "application/json" };
  const body = { assistant: overlay };

  // Try PATCH first
  try {
    const { data } = await axios.patch(url, body, { headers, timeout: 20000 });
    return data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404 || status === 405) {
      // Try PUT if resource or method not supported
      try {
        const { data } = await axios.put(url, body, { headers, timeout: 20000 });
        return data;
      } catch (err2) {
        throw decorateVapiError("PUT", url, err2);
      }
    }
    throw decorateVapiError("PATCH", url, err);
  }
}

// ---------------- HubSpot helpers ----------------
const hs = axios.create({
  baseURL: "https://api.hubapi.com",
  headers: HUBSPOT_ACCESS_TOKEN ? { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}` } : {},
  timeout: 20000
});

function normalizePhone(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  if (/^\+\d{7,15}$/.test(t)) return t;
  const digits = t.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
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
        "firstname","lastname","email","phone","mobilephone",
        "hs_lead_status","lifecyclestage","hs_lastcontacted",
        "lastmodifieddate","city","state","zip","address"
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
      properties: ["dealname","amount","dealstage","closedate","pipeline"],
      inputs: ids.map(id => ({ id }))
    };
    const resp = await hs.post(dealUrl, body);
    return (resp?.data?.results || []).map(d => ({ id: d.id, ...d.properties }));
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
  const lastContact = p.hs_lastcontacted ? new Date(p.hs_lastcontacted).toLocaleDateString() : null;
  const dealSnippet = deals?.length
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

// Debug: list assistants to verify base URL + API key + IDs
app.get("/admin/list-assistants", async (_req, res) => {
  try {
    const { data } = await axios.get(`${VAPI_BASE_URL}/v1/assistants`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
      timeout: 20000
    });
    res.json({ ok: true, base: VAPI_BASE_URL, assistants: data });
  } catch (err) {
    res.status(500).json({ ok: false, base: VAPI_BASE_URL, error: err?.response?.data || err.message });
  }
});

// Debug: fetch a single assistant
app.get("/admin/get-assistant", async (req, res) => {
  const id = (req.query.id || VAPI_ASSISTANT_ID || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing ?id or VAPI_ASSISTANT_ID" });
  try {
    const { data } = await axios.get(`${VAPI_BASE_URL}/v1/assistants/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
      timeout: 20000
    });
    res.json({ ok: true, base: VAPI_BASE_URL, assistant: data });
  } catch (err) {
    res.status(500).json({ ok: false, base: VAPI_BASE_URL, id, error: err?.response?.data || err.message });
  }
});

// Admin: re-apply overlay on demand
app.post("/admin/update-assistant", async (_req, res) => {
  try {
    const data = await patchAssistantOverlay();
    res.json({ ok: true, assistant_id: VAPI_ASSISTANT_ID, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ---- Vapi Assistant Request Webhook ----
// Configure in Vapi → Assistant → Webhooks → Assistant Request (POST)
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

    // Per-call override: guarantees real-time behavior even if API update is blocked
    return res.json({
      ok: true,
      assistant: {
        variables: { property_street, last_summary },
        firstMessage:
          "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?",
        ...overlay // include barge-in/VAD/ASR/latency policies per-call
      }
    });
  } catch (err) {
    console.error("assistant-request webhook error:", err);
    // Fail-open to let Vapi proceed without overrides if our webhook hiccups
    return res.json({ ok: true });
  }
});

// ---------------- Boot: apply overlay now (PATCH -> PUT fallback) ----------------
(async function boot() {
  try {
    console.log(`⏳ Applying Vapi barge-in/streaming overlay … (${VAPI_BASE_URL})`);
    const data = await patchAssistantOverlay();
    console.log("✅ Overlay applied to assistant:", {
      id: VAPI_ASSISTANT_ID,
      name: data?.assistant?.name || "(unnamed)"
    });
  } catch (err) {
    console.error("❌ Failed to apply overlay on boot:", err.message);
    console.error("   (Per-call override will still apply via /webhooks/vapi/assistant-request)");
  }
})();

app.listen(PORT, () => {
  console.log(`🚀 server listening on http://0.0.0.0:${PORT}`);
});
