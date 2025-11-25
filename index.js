import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// URL correta do Rasa REST webhook
const RASA_URL = "http://rede_andrade_rasa-server:5005/webhooks/rest/webhook";

// Concatena todas as mensagens do estilo OpenAI
function buildPrompt(messages) {
  return messages
    .map(m => {
      if (m.role === "system") return `### SYSTEM\n${m.content}`;
      if (m.role === "assistant") return `### ASSISTANT\n${m.content}`;
      return `### USER\n${m.content}`;
    })
    .join("\n\n");
}

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, model } = req.body;

    if (!messages || !messages.length) {
      return res.status(400).json({ error: "Missing messages" });
    }

    // Junta system + user + assistant em um prompt só
    const prompt = buildPrompt(messages);

    // Envia o prompt inteiro ao Rasa
    const rasaResponse = await fetch(RASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: "captain",
        message: prompt
      })
    });

    const rasaJson = await rasaResponse.json();
    const text = rasaJson?.[0]?.text || "";

    return res.json({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "rasa-proxy",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () =>
  console.log("Proxy Rasa rodando na porta 3000")
);
