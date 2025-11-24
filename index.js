cat << 'EOF' > /etc/easypanel/projects/rede_andrade/rasa-proxy-openai/code/index.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const RASA_URL = "http://rede_andrade_rasa-server:5005/webhooks/rest/webhook";

app.post("/v1/chat/completions", async (req, res) => {
  const userMessage = req.body?.messages?.find(m => m.role === "user")?.content || "";

  const rasaResponse = await fetch(RASA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: "captain", message: userMessage })
  });

  const rasaJson = await rasaResponse.json();
  const text = rasaJson?.[0]?.text || "";

  res.json({
    id: "rasa-proxy-" + Date.now(),
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop"
      }
    ]
  });
});

app.listen(3000, () => console.log("Proxy running"));
EOF
