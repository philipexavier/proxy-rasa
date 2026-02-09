import express from "express";
import { convertMessagesToPrompt } from "../utils/prompt.js";

function buildOpenAIResponse({ content, model, promptTokens = 0, completionTokens = 0 }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function buildStreamChunk({ content, model }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content,
        },
        finish_reason: null,
      },
    ],
  };
}

function createChatRouter({ llmService, defaultModel, logger }) {
  const router = express.Router();

  router.post("/v1/chat/completions", async (req, res, next) => {
    try {
      const payload = req.body || {};
      const { messages, temperature = 0.7, max_tokens: maxTokens = 512 } = payload;

      if (!payload.model || typeof payload.model !== "string") {
        return res.status(400).json({
          error: {
            message: "Missing or invalid model",
            type: "invalid_request_error",
          },
        });
      }

      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: "messages must be a non-empty array",
            type: "invalid_request_error",
          },
        });
      }

      const model = payload.model || defaultModel;
      const prompt = convertMessagesToPrompt(messages);

      logger.info(
        {
          model,
          temperature,
          maxTokens,
          stream: !!payload.stream,
        },
        "Forwarding request to LLM"
      );

      const llmResponse = await llmService.generate({
        prompt,
        temperature,
        maxTokens,
      });

      const content =
        llmResponse?.text ||
        llmResponse?.response ||
        llmResponse?.generated_text ||
        llmResponse?.content ||
        "";

      if (payload.stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        const chunk = buildStreamChunk({ content, model });
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            id: chunk.id,
            object: "chat.completion.chunk",
            created: chunk.created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return res.json(
        buildOpenAIResponse({
          content,
          model,
        })
      );
    } catch (error) {
      logger.error({ err: error }, "Failed to process chat completion");
      return next(error);
    }
  });

  return router;
}

export { createChatRouter };
