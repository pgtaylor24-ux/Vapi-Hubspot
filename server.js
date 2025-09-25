// server.js
// Minimal Vapi “config overlay” server:
// - On boot (and on demand), PATCH your Vapi assistant with bargeIn + streaming settings.
// - Optional: provide assistant-request webhook to inject dynamic variables (e.g., last_summary).

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const {
  PORT = 8080,
  VAPI_API_KEY,
  VAPI_ASSISTANT_ID, // existing assistant you use in Vapi
} = process.env;

if (!VAPI_API_KEY) {
  console.error("❌ Missing VAPI_API_KEY in env.");
  process.exit(1);
}
if (!VAPI_ASSISTANT_ID) {
  console.error("❌ Missing VAPI_ASSISTANT_ID in env.");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

// --- Assistant overlay config (kept tight & call-friendly) ---
const assistantOverlay = {
  // keep the actual talk short to make barge-in effective
  bargeIn: {
    enabled: true,
    minCallerSpeechMs: 120,
    resumeAfterInterruptMs: 80
  },
  transcription: {
    provider: "openai",                // or "deepgram" if you prefer
    model: "gpt-4o-mini-transcribe",   // streaming ASR
    partialResults: true,              // stream partials for faster turn-taking
    punctuate: true,
    smartFormat: true,
    noiseReduction: true,
    endpointing: {
      silenceDurationMs: 350,          // how quickly we end user's turn
      maxSpeechMs: 15000               // cut rambling
    }
  },
  vad: {                               // voice activity detection
    enabled: true,
    aggressiveness: 3,                 // 0–3
    minSpeechMs: 100,
    postSpeechMs: 120,
    preSpeechMs: 40
  },
  latency: { mode: "low" },
  tts: {
    provider: "elevenlabs",            // or your current TTS provider
    interruptOnVoice: true,            // IMPORTANT: allow cutoffs mid-utterance
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
  // Optional: tighten first message right here if you want the server to own it.
  // If you already set this in Vapi, you can omit these two lines.
  firstMessage: "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?",
  prompt:
    "You are Alex, a concise, friendly acquisitions agent for Taylor Real Estate Group. " +
    "Openings under 7 seconds. Stop speaking the instant the caller starts talking. " +
    "Keep replies short (max 2 sentences), one idea per reply. If bad time, offer to reschedule."
};

// --- Helper to PATCH assistant in Vapi ---
async function patchAssistant() {
  const url = `https://api.vapi.ai/v1/assistants/${encodeURIComponent(VAPI_ASSISTANT_ID)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ assistant: assistantOverlay })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vapi PATCH failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data;
}

// --- Health check ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// --- Admin: force re-apply overlay any time ---
app.post("/admin/update-assistant", async (_req, res) => {
  try {
    const data = await patchAssistant();
    res.json({ ok: true, assistant_id: VAPI_ASSISTANT_ID, applied: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- Optional: Vapi assistant-request webhook
// Configure this URL inside Vapi (Assistant → Webhooks → assistant-request)
// Vapi will call this BEFORE starting the conversation; you can inject variables/overrides.
app.post("/webhooks/vapi/assistant-request", async (req, res) => {
  try {
    // Example payload fields (exact shape may vary by Vapi version):
    // const { caller, callee, metadata } = req.body;

    // TODO: Look up your CRM/HubSpot here and build "last_summary".
    // For now, we stub a polite, short context.
    const vars = {
      property_street: req.body?.metadata?.property_street || "your property",
      last_summary:
        "Spoke in June; timing depended on moving to Florida. Price flexible if quick close; prefers text follow-up."
    };

    // You can also override parts of the assistant per-call (keeps bargeIn/VAD from the PATCH)
    const assistantOverrides = {
      variables: vars,
      firstMessage:
        "Hi, this is Alex with Taylor Real Estate Group. I'm calling about your property on {{property_street}}. Did I catch you at an okay time?"
    };

    // Respond in the shape Vapi expects (assistant override + variables)
    res.json({
      ok: true,
      assistant: assistantOverrides
    });
  } catch (err) {
    console.error("assistant-request webhook error:", err);
    // Fail-safe: let Vapi proceed without overrides
    res.json({ ok: true });
  }
});

// --- Boot: apply overlay immediately so every call uses barge-in + streaming ---
(async function boot() {
  try {
    console.log("⏳ Patching Vapi assistant with barge-in + streaming config …");
    const data = await patchAssistant();
    console.log("✅ Assistant overlay applied:", {
      assistantId: VAPI_ASSISTANT_ID,
      name: data?.assistant?.name || "(unnamed)"
    });
  } catch (err) {
    console.error("❌ Failed to apply assistant overlay on boot:", err);
  }
})();

app.listen(PORT, () => {
  console.log(`🚀 server listening on http://localhost:${PORT}`);
});
