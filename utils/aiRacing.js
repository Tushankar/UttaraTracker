// Fast, free, production-grade text models that support system prompts
const TEXT_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free", // Meta flagship, very reliable
  "mistralai/mistral-small-3.1-24b-instruct:free", // Mistral, fast + reliable
  "google/gemma-3-12b-it:free", // Google Gemma 3 12B, supports system msgs
  "arcee-ai/trinity-large-preview:free", // Arcee, 131k context, solid fallback
];

const VISION_MODEL = "nvidia/nemotron-nano-12b-v2-vl:free";

/**
 * Calls OpenRouter AI, racing multiple models if it's a text request,
 * or using a specific vision model if it includes an image.
 *
 * @param {Array} messages - Chat history/messages array
 * @param {boolean} isVision - Whether the request contains an image
 * @returns {Promise<string>} The generated text content
 */
async function callOpenRouterRacing(messages, isVision = false) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY not set");
  }

  const modelsToUse = isVision ? [VISION_MODEL] : TEXT_MODELS;

  // Create a fetch promise for each model
  const promises = modelsToUse.map((model) => {
    return new Promise(async (resolve, reject) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

      try {
        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://uttaratracker.onrender.com",
              "X-Title": "SSC Study Platform",
            },
            body: JSON.stringify({ model, messages }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const err = await response.text();
          reject(new Error(`OpenRouter (${model}) ${response.status}: ${err}`));
          return;
        }

        const data = await response.json();

        if (!data.choices || data.choices.length === 0) {
          reject(new Error(`OpenRouter (${model}) returned no choices.`));
          return;
        }

        const content = data.choices[0]?.message?.content;
        if (!content) {
          reject(new Error(`OpenRouter (${model}) choice has no content.`));
          return;
        }

        // Successfully got a response from this model!
        resolve({ model, content });
      } catch (err) {
        if (err.name === "AbortError") {
          reject(new Error(`OpenRouter (${model}) took too long.`));
        } else {
          reject(err);
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  });

  try {
    // Race them! Promise.any resolves when the FIRST promise resolves successfully.
    // If ALL promises reject, it throws an AggregateError.
    const fastestResponse = await Promise.any(promises);
    console.log(`🚀 Fastest model won: ${fastestResponse.model}`);
    return fastestResponse.content;
  } catch (aggregateError) {
    console.error(
      "❌ All AI models failed or timed out:",
      aggregateError.errors,
    );
    throw new Error(
      "AI is currently unavailable or taking too long. Please try again.",
    );
  }
}

module.exports = { callOpenRouterRacing };
