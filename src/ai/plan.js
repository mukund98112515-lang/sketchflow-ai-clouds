"use strict";

/**
 * Drawing plan generation. Produces the structured JSON plan for a tutorial:
 * { title, drawingMode, stepCount, steps: [{step, title, instruction, tip}] }
 *
 * A deterministic, analysis-driven template engine always works (no keys
 * required). When an AI provider key is configured the same schema is sent to
 * the LLM for richer, photo-specific wording; the response is validated and
 * falls back to the deterministic plan if anything is wrong.
 */

const config = require("../config");
const { validatePlan } = require("./validate");

/* ------------------------------------------------------------------ */
/* Stage templates                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build a master, ordered sequence of stage descriptors for a subject
 * profile + mode + shading preference. Later stages are dropped/kept based
 * on step count, and shading stages are inserted when shading is enabled.
 * The sequence always has at least as many stages as the maximum step count
 * so that every step of the tutorial maps to a distinct stage.
 */
function buildStages(prof, mode, stepCount, shading) {
  const s = [];

  s.push({
    key: "basic_shapes",
    title: `Basic ${prof.shapeNoun}`,
    instruction: `Begin with light, simple ${prof.shapeNounLower} that contain the whole ${prof.subject}. Keep every line very faint so it is easy to erase.`,
    tip: "Use the lightest pencil pressure you can. Shapes only need to be close — not perfect.",
  });

  s.push({
    key: "guidelines",
    title: prof.portrait ? "Center Guidelines" : "Proportion Guides",
    instruction: prof.portrait
      ? "Add a light vertical line through the centre of the oval and a horizontal line at the eye level. These split the face into even halves."
      : `Add light guide lines that divide the ${prof.subject} into clear sections: the main mass, the head, and the supporting parts. These act as a map for everything that follows.`,
    tip: "Step back and check symmetry. Small mistakes now grow into big ones later.",
  });

  if (mode !== "easy" || stepCount > 6) {
    s.push({
      key: "proportions",
      title: "Proportions",
      instruction: prof.portrait
        ? "Measure the proportions of the face: compare the width of the head to its height, and mark where the eyes, nose and mouth sit with tiny dots."
        : `Compare the key proportions of the ${prof.subject}: how long is the body compared to the head, how wide compared to how tall? Mark these with light dots.`,
      tip: "Measure with your pencil held at arm's length. Proportions are everything in a drawing.",
    });
  }

  s.push({
    key: "construction",
    title: prof.portrait ? "Face Structure" : "Construction",
    instruction: prof.portrait
      ? "Refine the oval into a head shape: soften the jaw, add the neck and shoulders with simple straight lines, and mark where the ears sit."
      : `Build the inner structure of the ${prof.subject} with straight construction lines, connecting the guide points. Think of it as a wireframe.`,
    tip: "Straight lines first, curves later. Construction is about placement, not prettiness.",
  });

  s.push({
    key: "contour",
    title: "Outer Contour",
    instruction: `Now define the outer edge of the ${prof.subject} with a confident line, following your construction guides. Include the overall silhouette only.`,
    tip: "Ignore the inside of the shape for now. Nail the outside edge and the rest becomes easier.",
  });

  s.push({
    key: "features",
    title: prof.featureTitle,
    instruction: prof.featureInstruction,
    tip: prof.featureTip,
  });

  if (stepCount >= 10) {
    s.push({
      key: "features_2",
      title: "Feature Details",
      instruction: `Go back over the features of the ${prof.subject} and make their shapes clearer: refine the outline of each one and connect them smoothly.`,
      tip: "Erase small construction marks inside the features before refining them.",
    });
  }

  if (mode !== "easy" || stepCount > 6) {
    s.push({
      key: "details",
      title: "Secondary Details",
      instruction: `Add the secondary details of the ${prof.subject}: smaller forms, texture changes and the shapes inside the main mass. Work from big to small.`,
      tip: "Always compare a detail back to the whole image before moving on.",
    });
  }

  if (stepCount >= 12) {
    s.push({
      key: "refine",
      title: "Refine Lines",
      instruction: `Clean up the drawing: darken the lines that matter, lighten or erase the ones that do not, and smooth any awkward curves.`,
      tip: "Use an eraser as a drawing tool, not just for mistakes.",
    });
  }

  if (shading) {
    if (mode === "realistic" || stepCount >= 10) {
      s.push({
        key: "shadow_map",
        title: "Map the Shadows",
        instruction: "Look for the darkest areas of the reference and map them with a light, even tone. Block them in before worrying about individual details.",
        tip: "Squint at the photo. Squinting reveals the big shadow shapes that make a drawing look real.",
      });
      s.push({
        key: "shading",
        title: "Build Tones",
        instruction: "Begin building tone with layers of parallel pencil strokes. Darken the shadow areas gradually and leave the bright areas untouched.",
        tip: "Layers of light strokes look smoother than one heavy pass. Build up slowly.",
      });
      s.push({
        key: "texture",
        title: prof.textureTitle || "Texture & Highlights",
        instruction: prof.textureInstruction,
        tip: "Use an eraser to lift out highlights and small light details on top of your shading.",
      });
    } else {
      s.push(prof.shadingStage);
    }
  }

  s.push({
    key: "final",
    title: "Final Sketch",
    instruction: `Finish the sketch: clean up construction lines, strengthen the main outlines and refine the details you care about most.`,
    tip: "Erase your construction guides once the final lines are in place.",
  });

  return s;
}

/** Sample `n` distinct stages from a longer master sequence, evenly spaced. */
function sampleStages(sequence, n) {
  if (n === 1) return [sequence[0]];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    let idx = Math.round((i / (n - 1)) * (sequence.length - 1));
    // Ensure uniqueness by nudging forward.
    while (seen.has(idx) && idx < sequence.length - 1) idx++;
    seen.add(idx);
    out.push(sequence[idx]);
  }
  return out;
}

function configShouldShade(mode, stages) {
  return false; // shading toggle handled by caller injecting the stage
}

/* ------------------------------------------------------------------ */
/* Subject profiles                                                    */
/* ------------------------------------------------------------------ */

function subjectProfile(subjectType, analysis) {
  const stats = analysis.stats || {};
  const cls = analysis.classification || {};
  const highContrast = (stats.std || 0) > 0.22;
  const busy = (cls.edgeDensity || 0) > 0.16;
  const dark = (cls.brightness || 0) < 0.4;
  const contrastHint = highContrast
    ? "The reference has strong light-dark contrast, so shadows will be a big part of the drawing."
    : "The reference is soft and even, so light pencil pressure and gentle outlines will suit it well.";
  const detailHint = busy
    ? "The photo is visually busy, so keep early stages loose and only add detail in the later steps."
    : "The photo has clean, simple shapes, so focus on getting the main forms accurate before adding anything else.";

  if (subjectType === "portrait") {
    return {
      portrait: true,
      subject: "portrait",
      subjectLabel: "Portrait",
      shapeNoun: "Head Shape",
      shapeNounLower: "oval",
      featureTitle: "Facial Features",
      featureInstruction:
        "Place the eyes on the horizontal guideline, the nose halfway between the eyes and chin, and the mouth between the nose and chin. Use light dots and dashes only.",
      featureTip: "Check the spaces between features, not the features themselves. Spacing is what makes a face recognisable.",
      textureInstruction:
        "Add hair in the direction it grows using short, flowing strokes. Soften the edges where the hair meets the face and pick out a few highlight strands.",
      shadingStage: {
        key: "light_shading",
        title: "Light Shading",
        instruction:
          "Add a first layer of soft shading under the jaw, along the sides of the nose and under the hairline. Keep the light areas clean so the face stays fresh.",
        tip: "Light shading is enough to add volume — you do not need to copy every shadow.",
      },
      contrastHint,
      detailHint,
    };
  }
  if (subjectType === "animal") {
    return {
      portrait: false,
      subject: "animal",
      subjectLabel: "Animal",
      shapeNoun: "Body Shapes",
      shapeNounLower: "ellipses",
      featureTitle: "Head and Features",
      featureInstruction:
        "Block in the head with a circle, then place the eyes, muzzle and ears using guide lines so they sit symmetrically on the face.",
      featureTip: "Animals are drawn the same way as people: shapes first, features last.",
      textureInstruction:
        "Suggest fur with short strokes that follow the shape of the body. Add longer, darker strokes only in the deepest shadow areas.",
      shadingStage: {
        key: "light_shading",
        title: "Light Shading",
        instruction:
          "Add a soft layer of shading under the chin, behind the legs and around the eyes to give the animal volume. Leave the top surfaces light.",
        tip: "Shade in the direction the fur grows for a more natural look.",
      },
      contrastHint,
      detailHint,
    };
  }
  if (subjectType === "object") {
    return {
      portrait: false,
      subject: "object",
      subjectLabel: "Object",
      shapeNoun: "Container Shapes",
      shapeNounLower: "boxes and ellipses",
      featureTitle: "Key Details",
      featureInstruction:
        "Pick out the identifying details of the object — the openings, handles, wheels or seams — and place them with short construction lines first.",
      featureTip: "Compare widths and heights with your pencil: 'how many heads tall is this?'.",
      textureInstruction:
        "Use smooth, even strokes for glossy surfaces and short, broken strokes for matte or rough textures.",
      shadingStage: {
        key: "light_shading",
        title: "Light Shading",
        instruction:
          "Add shading on the sides that turn away from the light, and a soft cast shadow underneath the object to ground it.",
        tip: "Keep one consistent light direction across the whole drawing.",
      },
      contrastHint,
      detailHint,
    };
  }
  if (subjectType === "vehicle") {
    return {
      portrait: false,
      subject: "vehicle",
      subjectLabel: "Vehicle",
      shapeNoun: "Body Boxes",
      shapeNounLower: "boxes and ellipses",
      featureTitle: "Wheels and Details",
      featureInstruction:
        "Block in the cabin and body as simple boxes, then place the wheels at the same height and spacing on both sides using light guide lines. Add windows and the main panel seams afterwards.",
      featureTip: "Wheels are the anchors of a vehicle drawing: get their position and size right and the body falls into place.",
      textureInstruction:
        "Use smooth, even strokes for painted panels and glass, and short cross-hatched strokes for tyres and dark trim.",
      shadingStage: {
        key: "light_shading",
        title: "Light Shading",
        instruction:
          "Add shading to the lower panels, under the wheel arches and inside the cabin where the light cannot reach. Leave the top surfaces bright.",
        tip: "Reflections on paint are lightest near the top edge of each panel.",
      },
      contrastHint,
      detailHint,
    };
  }
  if (subjectType === "landscape") {
    return {
      portrait: false,
      subject: "landscape",
      subjectLabel: "Landscape",
      shapeNoun: "Horizon Layout",
      shapeNounLower: "large shapes",
      featureTitle: "Foreground and Distant Forms",
      featureInstruction:
        "Mark the horizon line first, then sketch the largest forms in the foreground as simple shapes and position the distant ridges behind them. Keep distant lines faint.",
      featureTip: "Draw from back to front: sky and far shapes first, then mid-ground, foreground last.",
      textureInstruction:
        "Use short, broken strokes for foliage and grass, long even lines for still water, and barely-there marks for anything far away.",
      shadingStage: {
        key: "light_shading",
        title: "Light Shading",
        instruction:
          "Add a soft, even tone to the shadowed sides of the larger forms and beneath the foreground masses. Keep the sky and far distance nearly white.",
        tip: "Atmospheric perspective: the further away something is, the lighter and less detailed it becomes.",
      },
      contrastHint,
      detailHint,
    };
  }
  return {
    portrait: false,
    subject: "scene",
    subjectLabel: "Scene",
    shapeNoun: "Big Shapes",
    shapeNounLower: "large shapes",
    featureTitle: "Foreground Forms",
    featureInstruction:
      "Sketch the largest foreground forms as simple shapes, then position the mid-ground and background elements behind them using your guides.",
    featureTip: "Draw from back to front: background first, then middle ground, foreground last.",
    textureInstruction:
      "Keep distant areas light and simple, and add texture only in the foreground where it will be seen.",
    shadingStage: {
      key: "light_shading",
      title: "Light Shading",
      instruction:
        "Add shading on the sides of the forms that turn away from the light and beneath large objects to anchor them.",
      tip: "Atmospheric perspective: lighter and softer in the distance, darker in the foreground.",
    },
    contrastHint,
    detailHint,
  };
}

/* ------------------------------------------------------------------ */
/* Public: build a deterministic plan                                  */
/* ------------------------------------------------------------------ */

function buildDeterministicPlan(analysis, { mode, stepCount, shading }) {
  const cls = analysis.classification || {};
  const subjectType = cls.subjectType || "object";
  const prof = subjectProfile(subjectType, analysis);
  const stages = buildStages(prof, mode, stepCount, !!shading);
  const sampled = sampleStages(stages, stepCount);

  // Ensure the plan's first stage is construction and last is the final sketch.
  const plan = {
    title: `${prof.subjectLabel} Drawing`,
    subjectLabel: cls.label || prof.subjectLabel,
    drawingMode: mode,
    stepCount,
    steps: [],
  };

  const n = stepCount;
  for (let i = 0; i < n; i++) {
    const pick = sampled[i];
    let instruction = pick.instruction;
    let tip = pick.tip;
    // Tailor a few lines with real analysis values.
    if (pick.key === "basic_shapes") {
      instruction = `${instruction} ${prof.detailHint}`;
    }
    if (pick.key === "contour" && (mode === "realistic" || i === n - 2)) {
      instruction = `${instruction} ${prof.contrastHint}`;
    }
    if (pick.key === "final" && shading && mode !== "realistic") {
      instruction = `${instruction} Your shading guide is included, so keep the tone even and build it in layers.`;
      tip = "Compare your darkest and lightest areas against the reference before finishing.";
    }
    plan.steps.push({
      step: i + 1,
      title: pick.title,
      instruction,
      tip,
    });
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* LLM enhancement (optional)                                          */
/* ------------------------------------------------------------------ */

async function enhanceWithLlm(plan, analysis, imageBuffer) {
  if (!config.aiApiKey) return { plan, used: false };
  try {
    const small = await downscaleForLlm(imageBuffer);
    const cls = analysis.classification || {};
    const analysisText = JSON.stringify({
      subjectType: cls.subjectType,
      label: cls.label,
      brightness: Math.round(cls.brightness * 100),
      contrast: Math.round(cls.contrast * 100),
      edgeDensity: Math.round(cls.edgeDensity * 100),
      faceDetected: !!analysis.faceBox,
      suggestedTitle: plan.title,
    });

    const schema = `Return ONLY valid JSON matching exactly:
{"title":"string","steps":[{"step":number,"title":"string","instruction":"string","tip":"string"}]}
with ${plan.stepCount} steps, sequential step numbers 1..${plan.stepCount}.`;

    const base64 = small.toString("base64");

    if (config.aiProvider === "gemini") {
      const url = config.aiBaseUrl || `https://generativelanguage.googleapis.com/v1beta/models/${config.aiModel || "gemini-2.0-flash"}:generateContent`;
      const url2 = url.includes("key=") ? url : `${url}?key=${config.aiApiKey}`;
      const body = {
        contents: [
          {
            parts: [
              {
                text:
                  `You are an expert art tutor. A user uploaded a drawing reference photo. Analysis: ${analysisText}. ` +
                  `Create a progressive pencil drawing tutorial in ${plan.drawingMode} mode (${plan.stepCount} steps, shading ${plan.shading ? "included" : "excluded"}). ` +
                  `Guide the learner from basic construction shapes to the finished sketch. Be specific to the photo. ${schema}`,
              },
              { inlineData: { mimeType: "image/jpeg", data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      };
      const resp = await fetch(url2, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
      const json = await resp.json();
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      const parsed = JSON.parse(extractJson(text));
      return { plan: parsed, used: true };
    }

    // OpenAI-compatible
    const url = config.aiBaseUrl || "https://api.openai.com/v1/chat/completions";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiApiKey}`,
      },
      body: JSON.stringify({
        model: config.aiModel || "gpt-4o-mini",
        max_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an expert pencil-art tutor. You always reply with the requested JSON only.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `A user uploaded a drawing reference photo. Analysis: ${analysisText}. ` +
                  `Create a progressive pencil drawing tutorial in ${plan.drawingMode} mode (${plan.stepCount} steps, shading ${plan.shading ? "included" : "excluded"}). ` +
                  `Guide from basic construction shapes to finished sketch, specific to the photo. ${schema}`,
              },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(extractJson(text));
    return { plan: parsed, used: true };
  } catch {
    return { plan, used: false };
  }
}

function extractJson(text) {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function downscaleForLlm(buffer) {
  const Jimp = require("jimp");
  const img = await Jimp.read(buffer);
  const w = img.getWidth();
  const h = img.getHeight();
  const scale = Math.min(1, 768 / Math.max(w, h));
  if (scale < 1) {
    img.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), Jimp.RESIZE_BILINEAR);
  }
  return img.getBufferAsync(Jimp.MIME_JPEG);
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

async function buildPlan(analysis, opts) {
  const plan = buildDeterministicPlan(analysis, opts);
  let llmUsed = false;
  if (config.aiApiKey) {
    const res = await enhanceWithLlm(plan, analysis, opts.buffer);
    if (res.used) {
      const fixed = tryMerge(res.plan, plan);
      if (fixed) {
        plan.title = fixed.title;
        plan.steps = fixed.steps;
        llmUsed = true;
      }
    }
  }
  const validation = validatePlan(plan, opts);
  if (!validation.ok) {
    // Rebuild deterministically to guarantee a valid plan.
    const rebuilt = buildDeterministicPlan(analysis, opts);
    plan.title = rebuilt.title;
    plan.steps = rebuilt.steps;
  }
  return { plan, llmUsed };
}

/** Merge LLM output with deterministic fallback for missing/extra steps. */
function tryMerge(llmPlan, basePlan) {
  try {
    if (!llmPlan || !Array.isArray(llmPlan.steps) || llmPlan.steps.length === 0) return null;
    const steps = llmPlan.steps
      .map((s, idx) => ({
        step: Number(s.step) || idx + 1,
        title: String(s.title || "").slice(0, 80),
        instruction: String(s.instruction || "").slice(0, 900),
        tip: String(s.tip || "").slice(0, 400),
      }))
      .sort((a, b) => a.step - b.step);
    return {
      title: String(llmPlan.title || basePlan.title).slice(0, 80),
      steps,
    };
  } catch {
    return null;
  }
}

module.exports = { buildPlan, buildDeterministicPlan, validatePlan };
