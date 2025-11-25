import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// URL do Rasa interno
const RASA_URL = "http://rede_andrade_rasa-server:5005/webhooks/rest/webhook";

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !messages.length) {
      return res.status(400).json({ error: "Missing messages" });
    }

    // Última mensagem do usuário
    const userMessage = messages[messages.length - 1].content;

    // Chama o Rasa
    const rasaResponse = await fetch(RASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: "captain",
        message: userMessage
      })
    });

    const rasaJson = await rasaResponse.json();
    const text = rasaJson?.[0]?.text || "";

    // Resposta no formato OpenAI
    return res.json({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || "rasa-proxy",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text
          },
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
