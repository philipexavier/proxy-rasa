import express from "express";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";

import { createChatRouter } from "./routes/chat.js";
import { LlmService } from "./services/llm.js";
import { authMiddleware } from "./middleware/auth.js";

const PORT = Number(process.env.PORT || 3000);
const LLM_URL = process.env.LLM_URL || "http://local-llm:8000/generate";
const LLM_MODEL = process.env.LLM_MODEL || "jurema-7b";
const API_KEY = process.env.API_KEY || "";
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(
  pinoHttp({
    logger,
    redact: {
      paths: ["req.headers.authorization"],
      remove: true,
    },
  })
);

const llmService = new LlmService({
  llmUrl: LLM_URL,
  timeoutMs: LLM_TIMEOUT_MS,
});

app.use(authMiddleware(API_KEY));
app.use(createChatRouter({ llmService, defaultModel: LLM_MODEL, logger }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use((err, req, res, next) => {
  const status =
    err?.response?.status ||
    (err?.code === "ECONNABORTED" ? 504 : 500);
  const message =
    err?.response?.data?.error ||
    err?.message ||
    "internal_error";
  logger.error({ err }, "Unhandled error");
  res.status(status).json({
    error: {
      message,
      type: "internal_error",
    },
  });
  return;
});

app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      llmUrl: LLM_URL,
      model: LLM_MODEL,
      timeoutMs: LLM_TIMEOUT_MS,
      apiKeyConfigured: !!API_KEY,
    },
    "OpenAI-compatible proxy is running"
  );
});
