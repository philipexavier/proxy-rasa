// index.js
// Rasa ↔ Captain proxy (ESM) — Versão FINAL blindada para produção.
// Compatível com Captain Assistants, Copilot Threads, Rasa 3.x, LLM local (GGUF).

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

// ENV
const PORT = Number(process.env.PORT || 3000);
const RASA_URL = process.env.RASA_URL || "http://rede_andrade_rasa-server:5005";
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || null;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "rasa-proxy";
const DEBUG = !!process.env.DEBUG;
const ENABLE_PORTUGUESE_CORRECTION = process.env.PORTUGUESE_CORRECTION === "1";
const RASA_TIMEOUT_MS = Number(process.env.RASA_TIMEOUT_MS || 15000);
const MAX_MESSAGE_LEN = Number(process.env.MAX_MESSAGE_LEN || 12000);

// --- LOGGING ---
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

// --- HELPERS ---
function safeLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

function truncateText(s, max = MAX_MESSAGE_LEN) {
  if (!s || typeof s !== "string") return s;
  if (s.length <= max) return s;
  return s.slice(0, max - 100) + "\n\n... [truncated]";
}

// PT-BR normalizer leve
function normalizePortuguese(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/\bvc\b/gi, "você")
    .replace(/\bvcê\b/gi, "você")
    .replace(/\bpq\b/gi, "porque")
    .replace(/\bqnd\b/gi, "quando")
    .replace(/\btd\b/gi, "tudo")
    .replace(/\bmsm\b/gi, "mesmo")
    .replace(/\bnao\b/gi, "não")
    .replace(/\bnão\b/gi, "não")
    .replace(/\bobg\b/gi, "obrigado")
    .replace(/\bbrigad[oa]\b/gi, "obrigado")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// unify system message extraction
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
      if (typeof systemContent.text === "string") return systemContent.text;
      if (typeof systemContent.content === "string") return systemContent.content;
      if (Array.isArray(systemContent.content)) {
        return systemContent.content.map((c) => c.text || "").join(" ");
      }
      return JSON.stringify(systemContent);
    }
  } catch {
    return String(systemContent);
  }

  return String(systemContent);
}

function validateOpenAIRequest(body) {
  if (!body)
    return {
      ok: false,
      error: { error: { message: "Missing body", type: "invalid_request_error" } },
    };

  if (typeof validatorModule.validateOpenAIRequest === "function")
    return validatorModule.validateOpenAIRequest(body);

  if (typeof validatorModule.validate === "function")
    return validatorModule.validate(body);

  if (!body.model || typeof body.model !== "string")
    return {
      ok: false,
      error: { error: { message: "Missing or invalid model" } },
    };

  if (!Array.isArray(body.messages))
    return {
      ok: false,
      error: { error: { message: "messages must be array" } },
    };

  if (body.messages.length === 0)
    return {
      ok: false,
      error: { error: { message: "messages empty" } },
    };

  return { ok: true };
}

function isCaptainMode(messages = []) {
  if (!Array.isArray(messages)) return false;
  const systemContent = extractSystem(
    messages.find((m) => m.role === "system")?.content
  );
  return systemContent.includes("[Identity]") && systemContent.includes("[Task]");
}

function detectOperation(systemContent) {
  const system = extractSystem(systemContent).toLowerCase();
  if (!system) return null;
  if (system.includes("summarize")) return "summarize";
  if (system.includes("shorten")) return "shorten";
  if (system.includes("rephrase")) return "rephrase";
  if (system.includes("friendly")) return "friendly";
  if (system.includes("formal")) return "formal";
  if (system.includes("expand")) return "expand";
  if (system.includes("simplify")) return "simplify";
  if (system.includes("reply")) return "reply_suggestion";
  if (system.includes("label")) return "label_suggestion";
  return null;
}

// join LLM prompt
function joinMessagesForLLM(messages = []) {
  return messages
    .map((m) => {
      const role = (m.role || "user").toUpperCase();
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]\n${content}`;
    })
    .join("\n\n");
}

// Timeout wrapper
function fetchWithTimeout(url, opts = {}, timeoutMs = RASA_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(id)
  );
}

// LLM local fallback
async function callLocalLLM(prompt) {
  if (!LOCAL_LLM_URL) return { ok: false };
  try {
    const resp = await fetchWithTimeout(
      LOCAL_LLM_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      },
      RASA_TIMEOUT_MS
    );
    if (!resp.ok) return { ok: false };
    const j = await resp.json();
    return { ok: true, raw: j, source: "local_llm" };
  } catch (err) {
    safeLog("local LLM error:", err.message || err);
    return { ok: false };
  }
}

// Rasa fallback chain
async function callRasaApi({
  text,
  conversation_id = null,
  metadata = {},
  sender = "captain",
  parseOnly = false,
}) {
  // try local LLM first
  if (LOCAL_LLM_URL) {
    const local = await callLocalLLM(text);
    if (local.ok) return local;
  }

  // 1) conversation/<id>/parse
  try {
    if (conversation_id && !parseOnly) {
      const url = `${RASA_URL}/conversations/${encodeURIComponent(
        conversation_id
      )}/parse`;
      const r = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, metadata }),
        },
        RASA_TIMEOUT_MS
      );
      if (r.ok) return { ok: true, raw: await r.json(), source: "conversation_parse" };
    }
  } catch (err) {
    safeLog("conversation parse:", err.message || err);
  }

  // 2) model/parse
  try {
    const url = `${RASA_URL}/model/parse`;
    const r = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
      RASA_TIMEOUT_MS
    );
    if (r.ok) return { ok: true, raw: await r.json(), source: "model_parse" };
  } catch (err) {
    safeLog("model/parse:", err.message || err);
  }

  // 3) webhook
  try {
    const url = `${RASA_URL}/webhooks/rest/webhook`;
    const r = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, message: text }),
      },
      RASA_TIMEOUT_MS
    );
    if (r.ok) return { ok: true, raw: await r.json(), source: "rest_webhook" };
  } catch (err) {
    safeLog("rest_webhook:", err.message || err);
  }

  return { ok: false };
}

// adapter normalization
async function normalizeResponse(raw, opts = {}) {
  try {
    if (typeof rasaAdapter.normalizeRasaResponse === "function")
      return await rasaAdapter.normalizeRasaResponse(raw, opts);

    if (typeof rasaAdapter.normalize === "function")
      return await rasaAdapter.normalize(raw, opts);
  } catch (err) {
    safeLog("adapter error:", err.message || err);
  }

  // fallback
  if (!raw) return { reasoning: "", response: "", stop: false };

  if (Array.isArray(raw)) {
    const txt = raw
      .map((m) => (m?.text ? m.text : JSON.stringify(m)))
      .join("\n\n");
    return { reasoning: "", response: txt, stop: false };
  }

  if (typeof raw === "object") {
    const text =
      raw.text ||
      raw.response ||
      raw.generated_text ||
      raw.message ||
      "";
    return {
      reasoning: raw.reasoning || "",
      response: text,
      stop: !!raw.stop,
    };
  }

  return { reasoning: "", response: String(raw), stop: false };
}

// final wrapper
function buildOpenAIResponseObject(contentObj, model) {
  let safeContent;
  try {
    if (typeof contentObj === "string") {
      safeContent = contentObj;
    } else {
      safeContent = JSON.stringify(contentObj);
    }
  } catch (err) {
    safeContent = JSON.stringify({
      reasoning: "",
      response: "Erro ao serializar conteúdo.",
    });
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: safeContent },
        finish_reason: "stop",
      },
    ],
  };
}

// normalize copilot payload
function normalizeCopilotResponseFields(normalized) {
  const final = {
    reasoning: normalized.reasoning || "",
    response: normalized.response || "",
    stop: !!normalized.stop,
    label: normalized.label || "",
    metadata:
      typeof normalized.metadata === "object" && normalized.metadata
        ? normalized.metadata
        : {},
    sources: Array.isArray(normalized.sources)
      ? normalized.sources
      : normalized.sources
      ? [normalized.sources]
      : [],
  };

  // unify reply suggestions
  const rs = [];

  if (Array.isArray(normalized.reply_suggestions))
    rs.push(...normalized.reply_suggestions);

  if (Array.isArray(normalized.replySuggestions))
    rs.push(...normalized.replySuggestions);

  if (normalized.reply_suggestion) rs.push(normalized.reply_suggestion);
  if (normalized.replySuggestion) rs.push(normalized.replySuggestion);

  final.reply_suggestions = rs.filter(Boolean);

  return final;
}

// --- MAIN ROUTE ---
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const validation = validateOpenAIRequest(req.body);
    if (!validation.ok)
      return res.status(400).json(validation.error);

    const payload = req.body;
    const messages = Array.isArray(payload.messages)
      ? payload.messages
      : [];

    const systemRaw = messages.find((m) => m.role === "system")?.content;
    const systemMsg = extractSystem(systemRaw);
    const model = payload.model || DEFAULT_MODEL;

    // Copilot robust detection
    const copilotHeader =
      req.headers["x-copilot-threads"] ?? req.query.copilot ?? "";
    const copilot = ["1", "true", "yes"].includes(
      String(copilotHeader).toLowerCase()
    );

    const captainMode = isCaptainMode(messages);

    const applyPortugueseCorrection =
      ENABLE_PORTUGUESE_CORRECTION && !captainMode && !copilot;

    // CAPTAIN MODE — ultra-strito
    if (captainMode) {
      const lastUser =
        [...messages].reverse().find((m) => m.role === "user") || {
          content: "",
        };

      let userText =
        typeof lastUser.content === "string"
          ? lastUser.content
          : JSON.stringify(lastUser.content);

      if (applyPortugueseCorrection)
        userText = normalizePortuguese(userText);

      userText = truncateText(userText);

      const conversation_id =
        payload.conversation_id ||
        payload.metadata?.conversation_id ||
        uuidv4();

      const callResult = await callRasaApi({
        text: userText,
        conversation_id,
        metadata: payload.metadata || {},
        sender: "captain",
      });

      if (!callResult.ok) {
        const fallback = {
          reasoning: "",
          response:
            "Desculpe, não foi possível obter uma resposta do sistema de NLU/LLM.",
          stop: false,
          label: "",
          reply_suggestions: [],
          metadata: {},
        };
        return res.json(buildOpenAIResponseObject(fallback, model));
      }

      const normalized = await normalizeResponse(callResult.raw, {
        copilot,
        conversation_id,
      });

      const final = normalizeCopilotResponseFields(normalized);

      if (!final.response || !String(final.response).trim())
        final.response =
          "Desculpe, não encontrei informações suficientes para responder agora.";

      return res.json(buildOpenAIResponseObject(final, model));
    }

    // OPERATION MODE
    const operation = detectOperation(systemMsg);

    if (operation) {
      const merged = joinMessagesForLLM(
        messages.filter((m) => m.role !== "system")
      );

      const opPrompt = `OPERATION: ${operation}\n\n${merged}`;

      const callResult = await callRasaApi({
        text: opPrompt,
        conversation_id: payload.conversation_id,
      });

      if (!callResult.ok) {
        return res.json(
          buildOpenAIResponseObject(
            { reasoning: "", response: merged },
            model
          )
        );
      }

      const normalized = await normalizeResponse(callResult.raw, {
        operation,
      });

      const out = {
        reasoning: normalized.reasoning || "",
        response: normalized.response || "",
      };

      if (!out.response || !String(out.response).trim())
        out.response = "Desculpe, não tenho uma resposta agora.";

      return res.json(buildOpenAIResponseObject(out, model));
    }

    // FLOW DEFAULT
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user") || {
        content: "",
      };

    let finalPrompt =
      typeof lastUser.content === "string"
        ? lastUser.content
        : JSON.stringify(lastUser.content);

    if (applyPortugueseCorrection)
      finalPrompt = normalizePortuguese(finalPrompt);

    finalPrompt = truncateText(finalPrompt);

    const conversation_id =
      payload.conversation_id || uuidv4();

    const callResult = await callRasaApi({
      text: finalPrompt,
      conversation_id,
      metadata: payload.metadata || {},
      sender: "proxy-user",
    });

    if (!callResult.ok) {
      return res.json(
        buildOpenAIResponseObject(
          { reasoning: "", response: "" },
          model
        )
      );
    }

    const normalized = await normalizeResponse(callResult.raw, {
      conversation_id,
    });

    const out = {
      reasoning: normalized.reasoning || "",
      response: normalized.response || "",
    };

    // fallback anti-vazio (agora corrigido)
    if (!out.response || !String(out.response).trim())
      out.response = "Desculpe, não tenho uma resposta agora.";

    return res.json(buildOpenAIResponseObject(out, model));
  } catch (err) {
    console.error("[ERROR] /v1/chat/completions", err);
    return res
      .status(500)
      .json({ error: { message: "internal_error" } });
  }
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "rasa-captain-proxy-final",
  });
});

// Start
app.listen(PORT, () => {
  console.log(`Rasa ↔ Captain proxy listening on ${PORT}`);
  console.log(
    `RASA_URL=${RASA_URL} LOCAL_LLM_URL=${
      LOCAL_LLM_URL ? "yes" : "no"
    } DEBUG=${DEBUG ? 1 : 0}`
  );
});
