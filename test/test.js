import fetch from "node-fetch";

async function run() {
  const payload = {
    model: "rasa-proxy",
    messages: [{ role: "user", content: "Testando a rota" }]
  };

  const r = await fetch("http://localhost:3000/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  console.log("Status:", r.status);
  console.log("Body:", await r.json());
}

run();
