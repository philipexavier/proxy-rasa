import axios from "axios";

class LlmService {
  constructor({ llmUrl, timeoutMs }) {
    this.llmUrl = llmUrl;
    this.timeoutMs = timeoutMs;
    this.client = axios.create({
      timeout: timeoutMs,
    });
  }

  async generate({ prompt, temperature, maxTokens }) {
    const payload = {
      prompt,
      temperature,
      max_tokens: maxTokens,
    };

    const response = await this.client.post(this.llmUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    return response.data;
  }
}

export { LlmService };
