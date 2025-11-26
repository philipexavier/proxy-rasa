import fetch from "node-fetch";

async function run(op) {
  const payload = {
    model: "rasa-proxy",
    messages: [
      { role: "system", content: op },
      { role: "user", content: "O cliente quer cancelar a reserva" }
    ]
  };

  const r = await fetch("http://localhost:3000/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  console.log("\n=== OP:", op, "===");
  console.log("Status:", r.status);
  console.log("Body:", await r.json());
}

await run("summarize");
await run("rephrase");
await run("shorten");
await run("make_friendly");
