"use strict";

const config = require("../../config");
const logger = require("../../logger");
const { GeminiProvider } = require("./gemini");
const { OpenAIProvider } = require("./openai");
const { XaiProvider } = require("./xai");

let instance = null;

function getProvider() {
  if (instance) return instance;

  // ── XAI_ENABLED=false (default): deterministic-only, no external AI ──
  if (!config.xaiEnabled) {
    if (config.xaiApiKey || config.aiApiKey) {
      logger.info("xAI enhancement disabled (XAI_ENABLED=false). Using deterministic guide.");
    }
    return null;
  }

  const provider = (config.aiProvider || "xai").toLowerCase();
  const explicit = config.aiProviderExplicit;

  // When xAI/grok is EXPLICITLY requested (AI_PROVIDER=xai), require XAI_API_KEY.
  if ((provider === "xai" || provider === "grok") && explicit && !config.xaiApiKey) {
    throw new Error(`XAI_API_KEY is required when AI_PROVIDER=${provider}`);
  }

  if (!config.xaiApiKey && !config.aiApiKey) {
    logger.info("xAI enabled but no API key set. Using deterministic guide.");
    return null;
  }

  switch (provider) {
    case "xai":
    case "grok":
      instance = new XaiProvider(config);
      break;
    case "gemini":
    case "google":
      if (!config.aiApiKey) {
        throw new Error(`AI_API_KEY is required when AI_PROVIDER=${provider}`);
      }
      instance = new GeminiProvider(config);
      break;
    case "openai":
      if (!config.aiApiKey) {
        throw new Error(`AI_API_KEY is required when AI_PROVIDER=${provider}`);
      }
      instance = new OpenAIProvider(config);
      break;
    default:
      if (config.xaiApiKey) {
        instance = new XaiProvider(config);
      } else if (config.aiApiKey) {
        instance = new OpenAIProvider(config);
      }
  }

  return instance;
}

function resetProvider() {
  instance = null;
}

module.exports = { getProvider, resetProvider };
