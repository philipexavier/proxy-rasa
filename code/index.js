import express from "express";
import fetch from "node-fetch";
import { validateOpenAIRequest } from "./validator.js";

const app = express();
app.use(express.json());

const RASA_URL =
  process.env.RASA_URL ||
  "http://rede_andrade_rasa-server:5005/webhooks/rest/webhook";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_MODEL = "rasa-proxy";

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function joinMessages(messages) {
  return messages
    .map((m) => {
      const role = (m.role || "user").toLowerCase();
      return `[${role.toUpperCase()}]\n${m.content}`;
    })
    .join("\n\n");
}

function detectOperationFromSystem(systemContent) {
  if (!systemContent) return null;
  const s = systemContent.toLowerCase();

  if (s.includes("summarize")) return "summarize";
  if (s.includes("rephrase")) return "rephrase";
  if (s.includes("fix") || s.includes("grammar")) return "fix_spelling_grammar";
  if (s.includes("shorten")) return "shorten";
  if (s.includes("expand")) return "expand";
  if (s.includes("friendly")) return "make_friendly";
  if (s.includes("formal")) return "make_formal";
  if (s.includes("simplify")) return "simplify";
  if (s.includes("reply")) return "reply_suggestion";
  if (s.includes("label")) return "label_suggestion";

  return null;
}

// -------------------------------------------------------
// Detect Captain Requests
// -------------------------------------------------------

function isCaptainRequest(messages) {
  const sys = messages.find((m) => m.role === "system")?.content || "";
  return sys.includes("[Identity]") && sys.includes("[Task]");
}

// -------------------------------------------------------
// Summary fallback
// -------------------------------------------------------

function extractiveSummary(text, maxSentences = 3) {
  if (!text) return "";

  text = text.replace(/\r/g, " ").replace(/\n+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s) => s.trim().length > 20);

  const usable = filtered.length ? filtered : sentences;

  return usable.slice(0, maxSentences).join(" ").trim();
}

// -------------------------------------------------------
// RASA REQUEST
// -------------------------------------------------------

async function callRasa(prompt, sender = "captain") {
  try {
    const resp = await fetch(RASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, message: prompt }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Rasa error:", resp.status, text);
      return { ok: false, texts: [] };
    }

    const j = await resp.json();

    const texts = j
      .map((m) => m.text || m.message || null)
      .filter(Boolean);

    return { ok: true, texts };
  } catch (err) {
    console.error("Error calling Rasa:", err);
    return { ok: false, texts: [] };
  }
}

// -------------------------------------------------------
// OPENAI COMPATIBLE BUILDER
// -------------------------------------------------------

function buildOpenAIResponse(text, model) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || "",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: (text || "").length,
      total_tokens: (text || "").length,
    },
  };
}

// -------------------------------------------------------
// CHAT COMPLETIONS ENDPOINT
// -------------------------------------------------------

app.post("/v1/chat/completions", async (req, res) => {
  try {
    // Validate OpenAI format
    const validation = validateOpenAIRequest(req.body);
    if (!validation.ok) {
      return res.status(400).json(validation.error);
    }

    const { messages, model } = req.body;

    // ---------------------------------------------------
    // CAPTAIN REQUEST MODE
    // ---------------------------------------------------
    if (isCaptainRequest(messages)) {
      console.log("⚡ Captain request detected");

      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUser?.content || "";

      const rasaResp = await callRasa(userText);

      const responseText =
        rasaResp.ok && rasaResp.texts.length
          ? rasaResp.texts.join("\n")
          : "Desculpe, não consegui obter uma resposta agora.";

      // MUST respond EXACTLY in JSON format
      return res.json({
        reasoning:
          "A resposta foi gerada a partir do modelo conversacional treinado da Rede Andrade.",
        response: responseText,
      });
    }

    // ---------------------------------------------------
    // NORMAL OPENAI MODE
    // ---------------------------------------------------

    const systemMsg = messages.find((m) => m.role === "system");
    const systemContent = systemMsg?.content || null;

    const operation = detectOperationFromSystem(systemContent);
    const convoText = joinMessages(
      messages.filter((m) => m.role !== "system")
    );

    console.info("Proxy operation:", operation || "default");

    // SUMMARIZE
    if (operation === "summarize") {
      const rasaPrompt = `OPERATION: summarize\n\n${convoText}`;
      const rasaResp = await callRasa(rasaPrompt);

      if (rasaResp.ok && rasaResp.texts.length) {
        return res.json(
          buildOpenAIResponse(rasaResp.texts.join("\n"), model)
        );
      }

      const fallback = extractiveSummary(convoText);
      return res.json(buildOpenAIResponse(fallback, model));
    }

    // OTHER OPS
    if (operation && operation !== "summarize") {
      const rasaPrompt = `OPERATION: ${operation}\n\n${convoText}`;
      const rasaResp = await callRasa(rasaPrompt);

      if (rasaResp.ok && rasaResp.texts.length) {
        return res.json(
          buildOpenAIResponse(rasaResp.texts.join("\n"), model)
        );
      }

      return res.json(buildOpenAIResponse(convoText, model));
    }

    // DEFAULT
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastText = lastUser?.content || convoText;

    const rasaResp = await callRasa(lastText);

    if (rasaResp.ok && rasaResp.texts.length) {
      return res.json(
        buildOpenAIResponse(rasaResp.texts.join("\n"), model)
      );
    }

    return res.json(buildOpenAIResponse("", model));
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({
      error: { message: err.message, type: "internal_error" },
    });
  }
});

app.listen(PORT, () =>
  console.log(`Rasa Proxy listening on port ${PORT}`)
);
