"use strict";

/**
 * AI provider interface. Each provider implements `generateGuide({ base64Image, mimeType, mode, stepCount, shading })`.
 * Returns: { title, subjectType, mode, stepCount, shading, steps: [{ stepNumber, title, instruction, artistTip, visualDescription }] }
 */

class BaseProvider {
  constructor(config) {
    this.config = config;
  }

  async generateGuide({ base64Image, mimeType, mode, stepCount, shading }) {
    throw new Error("generateGuide() not implemented");
  }
}

module.exports = { BaseProvider };
