"use strict";

const { BaseProvider } = require("./base");

const SYSTEM_PROMPT = `You are an expert pencil-art teacher. Given a reference photo, analyze the ACTUAL uploaded image and produce a step-by-step drawing tutorial as structured JSON.

You MUST:
- Analyze the ACTUAL uploaded reference image
- Create a progressive manual drawing tutorial for reproducing this specific reference
- Do not merely describe the image — identify the subject and guide the user to draw it
- Identify the subject as: portrait | animal | vehicle | object | landscape | general
- Start from basic geometric masses, construction, axes, proportions, perspective
- Then structure, contours, feature placement
- Then details, refinement, texture, shading only when requested
- Follow the requested stepCount exactly
- Every step must build logically on the previous step

Return ONLY valid JSON matching this exact schema (no markdown fences, no extra text):
{
  "title": "string — descriptive tutorial title",
  "subjectType": "portrait | animal | vehicle | object | landscape | general",
  "mode": "easy | detailed | realistic",
  "stepCount": number,
  "shading": boolean,
  "steps": [
    {
      "stepNumber": number — 1-indexed sequential,
      "title": "string — short step title (max 60 chars)",
      "instruction": "string — clear drawing instruction (2-4 sentences)",
      "artistTip": "string — practical artist tip for this step",
      "visualDescription": "string — what the drawing should look like at this stage"
    }
  ]
}`;

const GUIDE_SCHEMA = {
  type: "json_schema",
  name: "drawing_guide",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      subjectType: {
        type: "string",
        enum: ["portrait", "animal", "vehicle", "object", "landscape", "general"],
      },
      mode: {
        type: "string",
        enum: ["easy", "detailed", "realistic"],
      },
      stepCount: { type: "integer" },
      shading: { type: "boolean" },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stepNumber: { type: "integer" },
            title: { type: "string" },
            instruction: { type: "string" },
            artistTip: { type: "string" },
            visualDescription: { type: "string" },
          },
          required: ["stepNumber", "title", "instruction", "artistTip", "visualDescription"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "subjectType", "mode", "stepCount", "shading", "steps"],
    additionalProperties: false,
  },
};

class XaiProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.apiKey = config.xaiApiKey;
    this.model = config.aiModel || "grok-2-vision-1212";
    this.baseUrl = "https://api.x.ai/v1/responses";
  }

  async generateGuide({ base64Image, mimeType, mode, stepCount, shading }) {
    const prompt =
      `Create a drawing tutorial with these parameters:\n` +
      `- Mode: ${mode}\n` +
      `- Number of steps: ${stepCount}\n` +
      `- Include shading: ${shading ? "yes" : "no"}\n` +
      `Analyze the uploaded photo carefully and create a step-by-step pencil drawing tutorial specific to this subject.`;

    const body = {
      model: this.model,
      store: false,
      text: {
        format: GUIDE_SCHEMA,
      },
      input: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${mimeType || "image/jpeg"};base64,${base64Image}`,
              detail: "high",
            },
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
      ],
    };

    // ── Pre-flight validation ──────────────────────────────────────────
    if (!body.model) throw new XaiError("CONFIG_ERROR", "xAI model is not configured.", 0);
    if (!body.input || !body.input.length) throw new XaiError("CONFIG_ERROR", "xAI request has no input.", 0);
    if (!body.text?.format?.type) throw new XaiError("CONFIG_ERROR", "xAI structured output format.type is missing.", 0);
    if (!body.text?.format?.name) throw new XaiError("CONFIG_ERROR", "xAI structured output format.name is missing.", 0);
    if (!body.text?.format?.schema) throw new XaiError("CONFIG_ERROR", "xAI structured output format.schema is missing.", 0);

    // ── Debug: sanitised request snapshot (no secrets, no image data) ──
    const logger = require("../../logger");
    logger.debug("xAI request:", JSON.stringify({
      endpoint: "/v1/responses",
      model: body.model,
      hasInput: body.input.length > 0,
      inputRoles: body.input.map((i) => i.role || "content"),
      text: { format: { type: body.text.format.type, name: body.text.format.name, strict: body.text.format.strict } },
      store: body.store,
    }));

    const resp = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      const errCode = resp.status;
      if (errCode === 401 || errCode === 403) {
        throw new XaiError("AUTH_FAILED", "xAI authentication failed. Check your API key.", errCode);
      }
      if (errCode === 429) {
        throw new XaiError("RATE_LIMITED", "xAI rate limit exceeded. Please try again later.", errCode);
      }
      if (errCode >= 500) {
        throw new XaiError("PROVIDER_ERROR", `xAI server error (${errCode}). Please try again.`, errCode);
      }
      throw new XaiError("API_ERROR", `xAI API error ${errCode}: ${errText.slice(0, 200)}`, errCode);
    }

    const json = await resp.json();
    const text = extractOutputText(json);
    if (!text) {
      throw new XaiError("EMPTY_RESPONSE", "xAI returned an empty response.", 0);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new XaiError("INVALID_JSON", "xAI returned invalid JSON.", 0);
    }

    return normalizeResponse(parsed, { mode, stepCount, shading });
  }
}

function extractOutputText(json) {
  if (!json || !Array.isArray(json.output)) return "";
  for (const item of json.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "";
}

function normalizeResponse(parsed, { mode, stepCount, shading }) {
  const validSubjectTypes = ["portrait", "animal", "vehicle", "object", "landscape", "general"];
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
    subjectType: validSubjectTypes.includes(parsed.subjectType) ? parsed.subjectType : "general",
    mode: ["easy", "detailed", "realistic"].includes(parsed.mode) ? parsed.mode : mode,
    stepCount: steps.length || stepCount,
    shading: typeof parsed.shading === "boolean" ? parsed.shading : shading,
    steps,
  };
}

class XaiError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = { XaiProvider, XaiError };
