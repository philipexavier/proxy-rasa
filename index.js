import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const RASA_URL = process.env.RASA_URL || "http://rede_andrade_rasa-server:5005/webhooks/rest/webhook";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_MODEL = "rasa-proxy";

// ---------- Helpers ----------

function joinMessages(messages) {
  // une mensagens preservando roles
  return messages
    .map(m => {
      const role = (m.role || "user").toLowerCase();
      return `[${role.toUpperCase()}]\n${m.content}`;
    })
    .join("\n\n");
}

function detectOperationFromSystem(systemContent) {
  if (!systemContent) return null;
  const s = systemContent.toLowerCase();
  if (s.includes("summarize") || s.includes("summary")) return "summarize";
  if (s.includes("rephrase")) return "rephrase";
  if (s.includes("fix spelling") || s.includes("fix grammar") || s.includes("spelling") || s.includes("grammar")) return "fix_spelling_grammar";
  if (s.includes("shorten")) return "shorten";
  if (s.includes("expand")) return "expand";
  if (s.includes("friendly")) return "make_friendly";
  if (s.includes("formal")) return "make_formal";
  if (s.includes("simplify")) return "simplify";
  if (s.includes("reply suggestion") || s.includes("reply_suggestion") ) return "reply_suggestion";
  if (s.includes("label_suggestion") || s.includes("label suggestion") ) return "label_suggestion";
  return null;
}

// very simple extractive summarizer: choose top sentences by length/position while filtering greetings
function extractiveSummary(text, maxSentences = 3) {
  if (!text) return "";

  // remove repeated whitespace
  text = text.replace(/\r/g, " ").replace(/\n+/g, " ").trim();

  // quick split into sentences
  const rawSentences = text.split(/(?<=[.!?])\s+/);

  // filter out small/greeting sentences
  const filtered = rawSentences.filter(s => {
    const low = s.toLowerCase();
    if (low.match(/^(hi|hey|hello|bom dia|boa tarde|boa noite|oi|olá|obrigad)/)) return false;
    if (s.trim().length < 20) return false;
    return true;
  });

  // if not enough sentences, fallback to rawSentences
  const candidates = filtered.length ? filtered : rawSentences;

  // score by length and position (earlier sentences slightly higher)
  const scored = candidates.map((s, i) => {
    const lenScore = s.split(/\s+/).length;
    const posScore = Math.max(0, 10 - i); // penalize later sentences a bit
    return { s, score: lenScore + posScore * 0.1 };
  });

  scored.sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, Math.min(maxSentences, scored.length)).map(x => x.s.trim());

  // preserve original reading order
  const ordered = candidates.filter(s => chosen.includes(s));

  return ordered.join(" ").trim();
}

async function callRasa(prompt, sender = "captain") {
  try {
    const resp = await fetch(RASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, message: prompt })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Rasa non-OK response:", resp.status, text);
      return { ok: false, text: null, raw: text };
    }

    const j = await resp.json();
    // Rasa returns an array of responses like [{ "text": "..." }]
    const text = Array.isArray(j) && j.length ? (j[0].text || (j[0].message && j[0].message)) : null;
    return { ok: true, text, raw: j };
  } catch (err) {
    console.error("Error calling Rasa:", err);
    return { ok: false, text: null, raw: String(err) };
  }
}

function buildOpenAIResponse(text, model, idPrefix = "chatcmpl") {
  return {
    id: `${idPrefix}-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text || "" },
        finish_reason: "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

// ---------- Main handler ----------

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, model } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ error: "Missing messages" });
    }

    // find system content if any
    const systemMsg = messages.find(m => (m.role || "").toLowerCase() === "system");
    const systemContent = systemMsg ? systemMsg.content : null;

    const operation = detectOperationFromSystem(systemContent);

    // build full conversation text from messages (user+assistant)
    const convoText = joinMessages(messages.filter(m => (m.role || "user").toLowerCase() !== "system"));

    console.info("Proxy: detected operation=", operation || "default");
    console.info("Proxy: model=", model || DEFAULT_MODEL);
    // If summarize — do local extractive summarization first
    if (operation === "summarize") {
      // we try Rasa fallback first: send explicit summarize operation so Rasa can do it if implemented
      const rasaPrompt = `OPERATION: summarize\n\n${convoText}`;
      const rasaResp = await callRasa(rasaPrompt, "captain");

      if (rasaResp.ok && rasaResp.text) {
        console.info("Proxy: Rasa returned summary (used).");
        return res.json(buildOpenAIResponse(rasaResp.text, model));
      }

      // fallback to local extractive summary
      console.info("Proxy: Rasa did not return usable summary — using local extractive summary.");
      const localSummary = extractiveSummary(convoText, 3);
      return res.json(buildOpenAIResponse(localSummary || " ", model));
    }

    // For reply_suggestion and other text transforms, send an operation tag + full prompt to Rasa
    if (operation && operation !== "summarize") {
      const rasaPrompt = `OPERATION: ${operation}\n\nSYSTEM_PROMPT:\n${systemContent || ""}\n\nCONVERSATION:\n${convoText}`;
      const rasaResp = await callRasa(rasaPrompt, "captain");

      if (rasaResp.ok && rasaResp.text) {
        return res.json(buildOpenAIResponse(rasaResp.text, model));
      }

      // fallback: try to produce a naive transformation in-proxy (very small heuristics)
      let fallbackText = "";

      const userOnly = messages.filter(m => (m.role || "user").toLowerCase() === "user").map(m => m.content).join("\n");
      switch (operation) {
        case "rephrase":
          fallbackText = userOnly; // no-op, leave as-is
          break;
        case "shorten":
          fallbackText = extractiveSummary(userOnly, 1);
          break;
        case "expand":
          fallbackText = userOnly + "\n\n(Expand: adicionar mais detalhes sobre passos a seguir.)";
          break;
        case "fix_spelling_grammar":
          fallbackText = userOnly; // naive: in-proxy we don't correct; rely on Rasa ideally
          break;
        case "make_friendly":
          fallbackText = `Olá! ${userOnly}`;
          break;
        case "make_formal":
          fallbackText = `Prezado(a),\n\n${userOnly}`;
          break;
        case "simplify":
          fallbackText = userOnly; // naive
          break;
        default:
          fallbackText = userOnly;
      }

      return res.json(buildOpenAIResponse(fallbackText, model));
    }

    // Default: just forward last user message to Rasa (reply flow)
    const lastUser = [...messages].reverse().find(m => (m.role || "user").toLowerCase() === "user");
    const lastText = lastUser ? lastUser.content : convoText;

    // prefer Rasa for replies
    const rasaResp = await callRasa(lastText, "captain");
    if (rasaResp.ok && rasaResp.text) {
      return res.json(buildOpenAIResponse(rasaResp.text, model));
    }

    // final fallback: empty assistant text
    return res.json(buildOpenAIResponse(" ", model));
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy Rasa rodando na porta ${PORT}`));
