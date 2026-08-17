"use strict";

const { BaseProvider } = require("./base");

const SYSTEM_PROMPT = `You are an expert pencil-art teacher. Given a reference photo, analyze it and produce a step-by-step drawing tutorial as structured JSON.

You must return ONLY valid JSON with this exact schema:
{
  "title": "string — descriptive tutorial title (e.g. 'How to Draw a Sleeping Cat')",
  "subjectType": "string — one of: portrait, animal, nature, man-made, other",
  "mode": "string — the requested mode: easy | detailed | realistic",
  "stepCount": number — the requested step count,
  "shading": boolean — whether shading is included,
  "steps": [
    {
      "stepNumber": number — 1-indexed sequential step number,
      "title": "string — short step title (max 60 chars)",
      "instruction": "string — clear drawing instruction (2-4 sentences)",
      "artistTip": "string — a helpful tip for this step (1-2 sentences)",
      "visualDescription": "string — brief description of what the drawing should look like at this stage"
    }
  ]
}

Guidelines:
- Start from basic construction shapes (circles, ovals, rectangles) and progressively add detail
- Each step builds on the previous one — never skip ahead
- Keep instructions beginner-friendly and specific to the subject in the photo
- Include practical artist tips (pencil pressure, symmetry checks, reference observations)
- In easy mode use large simple shapes; in detailed mode add structure; in realistic mode add fine detail
- If shading is enabled, include shading steps towards the end
- The visualDescription helps the user check their progress`;

class OpenAIProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.apiKey = config.aiApiKey;
    this.model = config.aiModel || "gpt-4o-mini";
    this.baseUrl = config.aiBaseUrl || "https://api.openai.com/v1/chat/completions";
  }

  async generateGuide({ base64Image, mimeType, mode, stepCount, shading }) {
    const prompt =
      `Create a drawing tutorial with these parameters:\n` +
      `- Mode: ${mode}\n` +
      `- Number of steps: ${stepCount}\n` +
      `- Include shading: ${shading ? "yes" : "no"}\n` +
      `Analyze the uploaded photo and create a step-by-step pencil drawing tutorial. ` +
      `Return ONLY the JSON object, no markdown fences, no extra text.`;

    const body = {
      model: this.model,
      max_tokens: 4096,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64Image}` } },
          ],
        },
      ],
    };

    const resp = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OpenAI API error ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(extractJson(text));
    return normalizeResponse(parsed, { mode, stepCount, shading });
  }
}

function extractJson(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function normalizeResponse(parsed, { mode, stepCount, shading }) {
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((s, i) => ({
        stepNumber: Number(s.stepNumber) || i + 1,
        title: String(s.title || "").slice(0, 80),
        instruction: String(s.instruction || "").slice(0, 900),
        artistTip: String(s.artistTip || s.tip || "").slice(0, 400),
        visualDescription: String(s.visualDescription || "").slice(0, 500),
        imageUrl: null,
      }))
    : [];

  return {
    title: String(parsed.title || "Drawing Tutorial").slice(0, 100),
    subjectType: String(parsed.subjectType || "other"),
    mode: parsed.mode || mode,
    stepCount: steps.length || stepCount,
    shading: typeof parsed.shading === "boolean" ? parsed.shading : shading,
    steps,
  };
}

module.exports = { OpenAIProvider };
