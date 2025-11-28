// index.js
// Rasa ↔ Captain proxy (ESM)
// Requirements: node 18+, install: express node-fetch helmet morgan uuid

import express from "express";
import fetch from "node-fetch";
import helmet from "helmet";
import morgan from "morgan";
import { v4 as uuidv4 } from "uuid";
import * as validatorModule from "./validator.js";
import * as rasaAdapter from "./adapters/rasa-to-captain.js";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "700kb" }));

// ENV / config
const PORT = Number(process.env.PORT || 3000);
const RASA_URL = process.env.RASA_URL || "http://rede_andrade_rasa-server:5005";
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || null;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "rasa-proxy";
const DEBUG = !!process.env.DEBUG;
const ENABLE_PORTUGUESE_CORRECTION = process.env.PORTUGUESE_CORRECTION === "1";
const RASA_TIMEOUT_MS = Number(process.env.RASA_TIMEOUT_MS || 15000);
const MAX_MESSAGE_LEN = Number(process.env.MAX_MESSAGE_LEN || 12000);

// Logging with masked headers
morgan.token("safe-headers", (req) => {
  try {
    const copy = { ...req.headers };
    if (copy.authorization) copy.authorization = "[REDACTED]";
    if (copy["x-api-key"]) copy["x-api-key"] = "[REDACTED]";
    return JSON.stringify(copy);
  } catch {
    return "{}";
  }
});
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms :safe-headers")
);

// Helpers
function safeLog(...args) {
  if (!DEBUG) return;
  console.log("[DEBUG]", ...args);
}

function safeJSON(obj) {
  try {
    return JSON.stringify(obj);
  } catch (err) {
    return JSON.stringify({
      reasoning: "",
      response: "Erro ao serializar resposta.",
      error: String(err && err.message ? err.message : err),
    });
  }
}

function maskSensitive(obj) {
  try {
    const copy = JSON.parse(JSON.stringify(obj));
    if (copy && copy.headers && copy.headers.authorization) copy.headers.authorization = "[REDACTED]";
    return copy;
  } catch {
    return obj;
  }
}

function truncateText(s, max = MAX_MESSAGE_LEN) {
  if (!s || typeof s !== "string") return s;
  if (s.length <= max) return s;
  return s.slice(0, max - 100) + "\n\n... [truncated]";
}

// Conservative Portuguese normalizer (only small shorthand -> full form)
function normalizePortuguese(text) {
  if (!text || typeof text !== "string") return text;
  const rules = [
    [/\bvc\b/gi, "você"],
    [/\bvcê\b/gi, "você"],
    [/\bqnd\b/gi, "quando"],
    [/\bpq\b/gi, "porque"],
    [/\btd\b/gi, "tudo"],
    [/\bmsm\b/gi, "mesmo"],
    [/\bnao\b/gi, "não"],
    [/\bnão\b/gi, "não"],
    [/\bobg\b/gi, "obrigado"],
    [/\bbrigad[oa]\b/gi, "obrigado"],
  ];
  let out = text;
  for (const [pat, rep] of rules) out = out.replace(pat, rep);
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

// Extract system message safely (handles string, array of chunks, object)
function extractSystem(systemContent) {
  if (!systemContent) return "";
  if (typeof systemContent === "string") return systemContent;
  try {
    if (Array.isArray(systemContent)) {
      return systemContent
        .map((c) => {
          if (!c) return "";
          if (typeof c === "string") return c;
          if (typeof c.text === "string") return c.text;
          if (typeof c.content === "string") return c.content;
          return "";
        })
        .filter(Boolean)
        .join(" ");
    }
    if (typeof systemContent === "object") {
      // try common nested shapes
      if (typeof systemContent.text === "string") return systemContent.text;
      if (typeof systemContent.content === "string") return systemContent.content;
      if (Array.isArray(systemContent.content)) {
        return systemContent.content.map((c) => (c.text ? c.text : "")).join(" ");
      }
      return JSON.stringify(systemContent);
    }
  } catch (err) {
    return String(systemContent);
  }
  return String(systemContent);
}

// Validate incoming OpenAI-style request: support both validator.validateOpenAIRequest and validator.validate
function validateOpenAIRequest(body) {
  if (!body) return { ok: false, error: { error: { message: "Missing body", type: "invalid_request_error" } } };

  // prefer exported named function `validateOpenAIRequest`
  if (typeof validatorModule.validateOpenAIRequest === "function") {
    return validatorModule.validateOpenAIRequest(body);
  }
  if (typeof validatorModule.validate === "function") {
    return validatorModule.validate(body);
  }
  // fallback simple validation
  if (!body.model || typeof body.model !== "string") return { ok: false, error: { error: { message: "Missing or invalid model", type: "invalid_request_error" } } };
  if (!Array.isArray(body.messages)) return { ok: false, error: { error: { message: "messages must be array", type: "invalid_request_error" } } };
  if (body.messages.length === 0) return { ok: false, error: { error: { message: "messages empty", type: "invalid_request_error" } } };
  return { ok: true };
}

// Detect captain mode (assistant + Task/Identity markers)
function isCaptainMode(messages = []) {
  if (!Array.isArray(messages)) return false;
  const systemContent = messages.find((m) => m.role === "system")?.content;
  const system = extractSystem(systemContent);
  return typeof system === "string" && system.includes("[Identity]") && system.includes("[Task]");
}

// Detect operation from system prompt
function detectOperationFromSystem(systemContent) {
  const system = extractSystem(systemContent);
  if (!system || typeof system !== "string") return null;
  const s = system.toLowerCase();
  if (s.includes("summarize")) return "summarize";
  if (s.includes("shorten")) return "shorten";
  if (s.includes("rephrase")) return "rephrase";
  if (s.includes("friendly")) return "friendly";
  if (s.includes("formal")) return "formal";
  if (s.includes("expand")) return "expand";
  if (s.includes("simplify")) return "simplify";
  if (s.includes("reply_suggestion") || s.includes("reply")) return "reply_suggestion";
  if (s.includes("label_suggestion") || s.includes("label")) return "label_suggestion";
  return null;
}

// Join messages for LLM prompts (preserve system separately)
function joinMessagesForLLM(messages = []) {
  return messages
    .map((m) => {
      const role = (m.role || "user").toString();
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role.toUpperCase()}]\n${content}`;
    })
    .join("\n\n");
}

// Timeout helper for fetch with AbortController
function fetchWithTimeout(url, opts = {}, timeoutMs = RASA_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const merged = { signal: controller.signal, ...opts };
  return fetch(url, merged).finally(() => clearTimeout(id));
}

// Try local LLM (if configured) - expects JSON response { text / generated_text / response }
async function callLocalLLM(prompt) {
  if (!LOCAL_LLM_URL) return { ok: false };
  try {
    const resp = await fetchWithTimeout(LOCAL_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }, RASA_TIMEOUT_MS);

    if (!resp.ok) return { ok: false, status: resp.status };
    const j = await resp.json();
    // Accept many shapes: { text }, { response }, { generated_text }, plain string
    return { ok: true, raw: j, source: "local_llm" };
  } catch (err) {
    safeLog("local LLM error", err && err.message ? err.message : err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Call Rasa: prefer conversations/<id>/parse, fallback to /model/parse, fallback to rest webhook
async function callRasaApi({ text, conversation_id = null, metadata = {}, sender = "captain", parseOnly = false }) {
  // prioritize local LLM if present
  if (LOCAL_LLM_URL) {
    const local = await callLocalLLM(text);
    if (local.ok) return local;
  }

  // If conversation_id provided -> try tracker parse
  try {
    if (conversation_id && !parseOnly) {
      const url = `${RASA_URL.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversation_id)}/parse`;
      safeLog("Rasa API (conversation parse)", { url, text: truncateText(text, 500) });
      const r = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, metadata }),
      }, RASA_TIMEOUT_MS);
      if (r.ok) {
        const json = await r.json();
        return { ok: true, raw: json, source: "conversation_parse" };
      } else {
        safeLog("conversation parse status", r.status);
      }
    }
  } catch (err) {
    safeLog("conversation parse error", err && err.message ? err.message : err);
  }

  // Try /model/parse
  try {
    const url = `${RASA_URL.replace(/\/$/, "")}/model/parse`;
    safeLog("Rasa API (model/parse)", { url, text: truncateText(text, 500) });
    const r = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }, RASA_TIMEOUT_MS);
    if (r.ok) {
      const json = await r.json();
      return { ok: true, raw: json, source: "model_parse" };
    } else {
      safeLog("model/parse status", r.status);
    }
  } catch (err) {
    safeLog("model parse error", err && err.message ? err.message : err);
  }

  // Fallback to rest webhook (dialogue bots that use it)
  try {
    const url = `${RASA_URL.replace(/\/$/, "")}/webhooks/rest/webhook`;
    safeLog("Rasa API (rest webhook)", { url, text: truncateText(text, 500), sender });
    const r = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, message: text }),
    }, RASA_TIMEOUT_MS);
    if (r.ok) {
      const json = await r.json();
      return { ok: true, raw: json, source: "rest_webhook" };
    } else {
      safeLog("rest webhook status", r.status);
      return { ok: false, error: `status ${r.status}` };
    }
  } catch (err) {
    safeLog("rest webhook error", err && err.message ? err.message : err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Normalize rasa response via adapter with safe fallbacks
async function normalizeResponse(raw, opts = {}) {
  // Adapter may export normalizeRasaResponse or default export
  try {
    if (typeof rasaAdapter.normalizeRasaResponse === "function") {
      return await rasaAdapter.normalizeRasaResponse(raw, opts);
    }
    if (typeof rasaAdapter.normalize === "function") {
      return await rasaAdapter.normalize(raw, opts);
    }
    if (typeof rasaAdapter.default === "function") {
      return await rasaAdapter.default(raw, opts);
    }
  } catch (err) {
    safeLog("adapter normalization error", err && err.message ? err.message : err);
    // continue to fallback normalization
  }

  // Fallback generic normalization
  if (!raw) {
    return { reasoning: "", response: "Desculpe, não foi possível obter uma resposta.", stop: false };
  }

  // If raw is array of messages (rest webhook)
  if (Array.isArray(raw)) {
    const texts = raw
      .map((m) => {
        if (!m) return null;
        if (typeof m === "string") return m;
        if (m.text) return m.text;
        if (m.message) return m.message;
        // try nested custom payloads
        if (m.custom && (m.custom.text || m.custom.message)) return m.custom.text || m.custom.message;
        return JSON.stringify(m);
      })
      .filter(Boolean);
    return { reasoning: "", response: texts.join("\n\n"), stop: false };
  }

  // If raw is object from model/parse or local LLM
  if (typeof raw === "object") {
    // local LLM shapes: { text } { response } { generated_text }
    const text = raw.text || raw.response || raw.generated_text || raw.output || raw.message || "";
    const intent = raw.intent || raw.intent_ranking || null;
    const entities = raw.entities || null;
    const reasoning = intent ? `Intent: ${JSON.stringify(intent)}` : (raw.reasoning || "");
    return {
      reasoning,
      response: (text || "").toString(),
      stop: !!raw.stop,
      intents: intent,
      entities,
      raw,
    };
  }

  // string fallback
  return { reasoning: "", response: String(raw), stop: false };
}

// Build OpenAI-compatible (Chat Completion) response for Captain
function buildOpenAIResponseObject(contentObj = {}, model = DEFAULT_MODEL) {
  // contentObj must be serializable to JSON; Captain expects choices[0].message.content to be a JSON string
  let safeContent;
  try {
    if (contentObj === null || contentObj === undefined) {
      safeContent = "";
    } else if (typeof contentObj === "string") {
      safeContent = contentObj;
    } else if (typeof contentObj === "object") {
      safeContent = safeJSON(contentObj);
    } else {
      // number, boolean, etc.
      safeContent = String(contentObj);
    }
  } catch (err) {
    safeContent = safeJSON({ error: "failed_to_serialize_content", detail: String(err && err.message ? err.message : err) });
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: safeContent,
        },
        finish_reason: "stop",
      },
    ],
  };
}

// Ensure copilot fields are well-formed
function normalizeCopilotResponseFields(normalized) {
  const out = {
    reasoning: normalized.reasoning || "",
    response: normalized.response || "",
    stop: !!normalized.stop,
    sources: Array.isArray(normalized.sources) ? normalized.sources : normalized.sources ? [normalized.sources] : [],
    metadata: typeof normalized.metadata === "object" && normalized.metadata !== null ? normalized.metadata : {},
    label: normalized.label || "",
    reply_suggestions: Array.isArray(normalized.reply_suggestions)
      ? normalized.reply_suggestions
      : normalized.reply_suggestions
      ? [normalized.reply_suggestion || normalized.reply_suggestions]
      : [],
  };
  return out;
}

// --- MAIN ROUTE ---
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const validation = validateOpenAIRequest(req.body);
    if (!validation.ok) {
      safeLog("validation failed", validation);
      return res.status(400).json(validation.error);
    }

    const payload = req.body;
    safeLog("incoming", maskSensitive(payload));

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const rawSystemContent = messages.find((m) => m.role === "system")?.content;
    const systemMsg = extractSystem(rawSystemContent);
    const model = payload.model || DEFAULT_MODEL;

    // Detect copilot header or query
    const copilotHeader = req.headers["x-copilot-threads"] || req.query.copilot || "";
    const copilot = copilotHeader === "1" || copilotHeader === "true";

    // Captain assistants detection
    const captainMode = isCaptainMode(messages);

    // If Portuguese correction is enabled, we only apply it in plain chat (not in captain mode, not in copilot operations)
    const applyPortugueseCorrection =
      ENABLE_PORTUGUESE_CORRECTION && !captainMode && !copilot;

    // If Captain mode -> special handling (assistants + copilot)
    if (captainMode) {
      safeLog("Captain mode detected", { copilot });

      // get last user message (prefer last role user)
      const lastUser = [...messages].reverse().find((m) => m.role === "user") || messages[messages.length - 1] || { content: "" };
      let userText = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);

      // Apply conservative normalization only for plain chat (avoid altering system's instructions)
      if (applyPortugueseCorrection) userText = normalizePortuguese(userText);
      userText = truncateText(userText);

      // conversation id support (if the caller passed it)
      const conversation_id =
        payload.conversation_id || (payload.metadata && payload.metadata.conversation_id) || uuidv4();

      // call Rasa (with conversation parse preferred)
      const callResult = await callRasaApi({ text: userText, conversation_id, metadata: payload.metadata || {}, sender: "captain" });

      if (!callResult.ok) {
        safeLog("Rasa call failed in captain mode", callResult);
        // Return minimal but valid JSON object (Captain needs JSON)
        const fallback = {
          reasoning: "",
          response: "Desculpe, não foi possível obter uma resposta do sistema de NLU/LLM.",
          stop: false,
          label: "",
          reply_suggestions: [],
          metadata: {},
        };
        return res.json(buildOpenAIResponseObject(fallback, model));
      }

      // Normalize via adapter
      const normalized = await normalizeResponse(callResult.raw, { copilot, conversation_id, source: callResult.source });

      // If adapter returns a string or missing fields, coerce
      const copilotPayload = normalizeCopilotResponseFields(normalized);

      // Ensure reply_suggestions is always array and label is string
      if (!Array.isArray(copilotPayload.reply_suggestions)) copilotPayload.reply_suggestions = [];
      if (typeof copilotPayload.label !== "string") copilotPayload.label = "";

      // Guarantee response non-empty
      if (!copilotPayload.response || copilotPayload.response.trim() === "") {
        // try to extract plain text from raw
        if (Array.isArray(callResult.raw)) {
          copilotPayload.response = callResult.raw.map((m) => (m.text ? m.text : JSON.stringify(m))).join("\n\n");
        } else if (callResult.raw && (callResult.raw.text || callResult.raw.response || callResult.raw.generated_text)) {
          copilotPayload.response = callResult.raw.text || callResult.raw.response || callResult.raw.generated_text;
        } else {
          copilotPayload.response = "Desculpe, não tenho uma resposta agora.";
        }
      }

      // Final structure for Captain: include fields Captain expects
      const final = {
        reasoning: copilotPayload.reasoning,
        response: copilotPayload.response,
        stop: copilotPayload.stop,
        label: copilotPayload.label,
        reply_suggestions: copilotPayload.reply_suggestions,
        sources: copilotPayload.sources,
        metadata: copilotPayload.metadata,
      };

      safeLog("Captain response", { final: truncateText(JSON.stringify(final), 1000) });

      return res.json(buildOpenAIResponseObject(final, model));
    }

    // Not captain mode → look for operations in system message
    const operation = detectOperationFromSystem(systemMsg);
    const merged = joinMessagesForLLM(messages.filter((m) => m.role !== "system"));

    // If operation -> instruct Rasa/LLM about operation
    if (operation) {
      safeLog("Operation detected", operation);
      // build prompt that Rasa/LLM can parse
      const opPrompt = `OPERATION: ${operation}\n\n${merged}`;
      const callResult = await callRasaApi({ text: opPrompt, conversation_id: payload.conversation_id || undefined });

      if (!callResult.ok) {
        safeLog("operation call failed", callResult);
        return res.json(buildOpenAIResponseObject({ reasoning: "", response: merged }, model));
      }

      const normalized = await normalizeResponse(callResult.raw, { operation });
      const out = {
        reasoning: normalized.reasoning || "",
        response: normalized.response || merged,
      };
      return res.json(buildOpenAIResponseObject(out, model));
    }

    // DEFAULT chat flow -> send last user message to Rasa/LLM
    const lastUser = [...messages].reverse().find((m) => m.role === "user") || { content: merged };
    let finalPrompt = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);

    if (applyPortugueseCorrection) finalPrompt = normalizePortuguese(finalPrompt);
    finalPrompt = truncateText(finalPrompt);

    const conversation_id = payload.conversation_id || uuidv4();
    const callResult = await callRasaApi({ text: finalPrompt, conversation_id, metadata: payload.metadata || {}, sender: "proxy-user" });

    if (!callResult.ok) {
      safeLog("Rasa final call failed", callResult);
      return res.json(buildOpenAIResponseObject({ reasoning: "", response: "" }, model));
    }

    const normalized = await normalizeResponse(callResult.raw, { conversation_id, source: callResult.source });
    const out = { reasoning: normalized.reasoning || "", response: normalized.response || "" };

    return res.json(buildOpenAIResponseObject(out, model));
  } catch (err) {
    console.error("[ERROR] /v1/chat/completions", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: { message: err.message || "internal_error", type: "internal_error" } });
  }
});

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "rasa-captain-proxy-1.0" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Rasa ↔ Captain proxy listening on port ${PORT}`);
  console.log(`RASA_URL=${RASA_URL} LOCAL_LLM_URL=${LOCAL_LLM_URL ? "yes" : "no"} DEBUG=${DEBUG ? 1 : 0}`);
});
