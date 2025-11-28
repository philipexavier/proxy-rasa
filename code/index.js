import express from "express";
import fetch from "node-fetch";
import { validateOpenAIRequest } from "./validator.js";
import { normalizeRasaResponse } from "./adapters/rasa-to-captain.js";

const app = express();
app.use(express.json());

const RASA_URL =
  process.env.RASA_URL ||
  "http://rede_andrade_rasa-server:5005/webhooks/rest/webhook";

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || null;

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_MODEL = "rasa-proxy";

/* ---------------------------------------------
   Utilitário central → sempre devolve string JSON
   Captain exige: choices[0].message.content = string JSON
----------------------------------------------*/
function safeJSON(data) {
  try {
    return JSON.stringify(data);
  } catch (err) {
    return JSON.stringify({
      reasoning: "",
      response: "Erro ao serializar resposta.",
      error: err.message
    });
  }
}

/* ---------------------------------------------
   Helpers
----------------------------------------------*/
function isCaptainMode(messages) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  return system.includes("[Identity]") && system.includes("[Task]");
}

function joinMessagesForLLM(messages) {
  return messages
    .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join("\n\n");
}

function detectOperation(sys) {
  if (!sys) return null;
  const s = sys.toLowerCase();
  if (s.includes("summarize")) return "summarize";
  if (s.includes("shorten")) return "shorten";
  if (s.includes("rephrase")) return "rephrase";
  if (s.includes("friendly")) return "friendly";
  if (s.includes("formal")) return "formal";
  if (s.includes("expand")) return "expand";
  if (s.includes("simplify")) return "simplify";
  if (s.includes("reply")) return "reply_suggestion";
  if (s.includes("label")) return "label_suggestion";
  return null;
}

/* ---------------------------------------------
   LLM local opcional
----------------------------------------------*/
async function callLocalLLM(prompt) {
  if (!LOCAL_LLM_URL) return { ok: false };
  try {
    const r = await fetch(LOCAL_LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    });

    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, raw: j };
  } catch {
    return { ok: false };
  }
}

/* ---------------------------------------------
   Chamada principal ao Rasa
----------------------------------------------*/
async function callRasa(text, sender = "captain") {
  try {
    // prioridade ao LLM local se estiver ativado
    if (LOCAL_LLM_URL) {
      const local = await callLocalLLM(text);
      if (local.ok) return local;
    }

    const r = await fetch(RASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, message: text })
    });

    if (!r.ok) return { ok: false };

    return { ok: true, raw: await r.json() };
  } catch (err) {
    console.error("Rasa error:", err);
    return { ok: false };
  }
}

/* ---------------------------------------------
   OpenAI-compatible wrapper
----------------------------------------------*/
function buildOpenAIResponse(content, model = DEFAULT_MODEL) {
  const safeContent =
    typeof content === "string" ? content : safeJSON(content);

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: safeContent },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: safeContent.length,
      total_tokens: safeContent.length
    }
  };
}

/* ---------------------------------------------
   ENDPOINT PRINCIPAL
----------------------------------------------*/
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const valid = validateOpenAIRequest(req.body);
    if (!valid.ok) return res.status(400).json(valid.error);

    const { messages, model } = req.body;

    // CAPTAIN → Assistants + Copilot
    if (isCaptainMode(messages)) {
      console.log("⚡ Captain mode triggered");

      const lastUser =
        [...messages].reverse().find((m) => m.role === "user") || {};
      const query = lastUser.content || "";

      const rasa = await callRasa(query);
      const normalized = rasa.ok
        ? normalizeRasaResponse(rasa.raw)
        : { response: "Erro ao obter resposta do servidor." };

      return res.json(
        buildOpenAIResponse(
          {
            reasoning: normalized.reasoning || "",
            response: normalized.response || "",
            stop: normalized.stop || false,
            reply_suggestion: normalized.reply_suggestion || false,
            label_suggestion: normalized.label_suggestion || false,
            sources: normalized.sources || null,
            metadata: normalized.metadata || null
          },
          model
        )
      );
    }

    // OPERAÇÕES
    const systemMsg = messages.find((m) => m.role === "system");
    const operation = detectOperation(systemMsg?.content);
    const merged = joinMessagesForLLM(messages.filter((m) => m.role !== "system"));

    if (operation) {
      const rasa = await callRasa(`OPERATION: ${operation}\n\n${merged}`);
      const normalized = rasa.ok ? normalizeRasaResponse(rasa.raw) : null;

      return res.json(
        buildOpenAIResponse(normalized?.response || merged, model)
      );
    }

    // MODO PADRÃO
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user") || {};
    const finalPrompt = lastUser.content || merged;

    const rasa = await callRasa(finalPrompt);
    const normalized = rasa.ok ? normalizeRasaResponse(rasa.raw) : null;

    return res.json(
      buildOpenAIResponse(normalized?.response || "", model)
    );
  } catch (err) {
    console.error("Proxy crash:", err);
    return res.status(500).json({
      error: { message: err.message, type: "internal_error" }
    });
  }
});

/* ---------------------------------------------*/
app.listen(PORT, () =>
  console.log(`🔥 Rasa Proxy rodando na porta ${PORT}`)
);
