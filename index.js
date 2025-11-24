import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// URL do Rasa dentro da overlay network
const RASA_URL = "http://10.0.1.13:5005/webhooks/rest/webhook";

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const userMessage =
      req.body?.messages?.find((m) => m.role === "user")?.content || "";

    const rasaResponse = await fetch(RASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "captain", message: userMessage }),
      timeout: 15000, // 15s
    });

    const rasaJson = await rasaResponse.json();
    const text = rasaJson?.[0]?.text || "Sem resposta do Rasa.";

    res.json({
      id: "rasa-proxy-" + Date.now(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
    });
  } catch (err) {
    console.error("Erro ao consultar Rasa:", err.message);

    res.json({
      id: "rasa-proxy-error-" + Date.now(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              "Desculpe, não consegui obter resposta do servidor Rasa agora.",
          },
          finish_reason: "error",
        },
      ],
    });
  }
});

app.listen(3000, "0.0.0.0", () =>
  console.log("Proxy Rasa rodando na porta interna 3000")
);
