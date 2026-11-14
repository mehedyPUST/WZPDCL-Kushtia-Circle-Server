import express, { type Request, type Response } from "express";
import {
  generateRestTimeData,
  buildNightWindow,
  DEFAULT_NIGHT_START,
  DEFAULT_NIGHT_END,
  RESIDENTIAL_IDS,
  approximateFajrHour,
} from "../lib/restTimeGenerate.js";
import { FEEDERS } from "../lib/constants.js";

const router = express.Router();

function resolveProvider() {
  const groqKey = process.env.GROQ_API_KEY || process.env.GROQ_KEY || "";
  if (!groqKey) return null;

  return {
    name: "groq" as const,
    apiKey: groqKey,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
  };
}

function buildSystemPrompt(fajrH: number, friday: boolean) {
  const feederLines = FEEDERS.map((f) => {
    const kind = RESIDENTIAL_IDS.has(f.id)
      ? "residential/mixed — stronger overnight dip"
      : "industrial/outgoing — flatter night profile";
    return `  - id ${f.id} ${f.name} (bus ${f.bus}): ${kind}`;
  }).join("\n");

  return `You are a senior duty engineer at Bottail 33/11 kV Substation (WZPDCL, Kushtia Circle, Bangladesh).
Your task is to produce REALISTIC intermediate night-log feeder amperes and bus voltages.

STATION CONTEXT
- Two 33 kV buses (Bus-1, Bus-2). Practical light-load ceilings ≈ Bus-1 36.0 kV, Bus-2 35.6 kV.
- Night demand falls after midnight, trough near Fajr (~${fajrH.toFixed(2)} h local), then rises toward morning industrial / residential wake-up.
- Today is ${friday ? "FRIDAY — BRB (feeder 1) often reduced or zero by ~07:00 if plant offline for Jumu'ah; apply gently" : "a normal weekday — no Friday special"}.

FEEDERS
${feederLines}

HARD RULES
1. NEVER change operator-provided anchor slots (start, end, and any mid anchors the user filled). Copy them exactly.
2. Only fill intermediate (non-anchor) hours.
3. Amps = non-negative integers. Bus kV = one decimal place.
4. Shape must be physically smooth: no spikes, no random jumps between adjacent hours.
5. Residential feeders (3,4,5,6) dip more overnight than industrial/outgoing (1,2,7,8,9).
6. When total station amps fall, bus voltages rise slightly (inverse load), never above ceilings.
7. Prefer refining the provided localSeed rather than inventing a different curve from scratch.
8. Output ONLY valid JSON — no markdown fences, no commentary.

OUTPUT SCHEMA
{
  "slots": {
    "HH:mm": {
      "amps": { "1": number, "2": number, "3": number, "4": number, "5": number, "6": number, "7": number, "8": number, "9": number },
      "bus1": number,
      "bus2": number
    }
  }
}`;
}

router.post("/generate", async (req: Request, res: Response) => {
  let body: any;
  try {
    body = req.body;
  } catch {
    return res.status(400).json({ success: false, message: "Invalid JSON body" });
  }

  const dayKey = String(body?.dayKey || "");
  const slots = body?.slots || {};
  const startSlot = body?.startSlot || DEFAULT_NIGHT_START;
  const endSlot = body?.endSlot || DEFAULT_NIGHT_END;
  const window = buildNightWindow(startSlot, endSlot);

  const month = dayKey ? Number(dayKey.split("-")[1]) : new Date().getMonth() + 1;
  const fajrH = approximateFajrHour(month);
  const friday = (() => {
    if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return false;
    const [y, m, d] = dayKey.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay() === 5;
  })();

  // Always compute a high-quality local seed first (also the sole path if no API key)
  let seed: any;
  try {
    seed = generateRestTimeData({
      dayKey,
      slots,
      startSlot,
      endSlot,
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err?.message || "Missing required anchors" });
  }

  const provider = resolveProvider();
  if (!provider) {
    return res.json({
      success: true,
      data: seed,
      meta: { source: "local", engine: seed?.meta?.engine || "local-v2" },
    });
  }

  const anchors: Record<string, unknown> = {};
  for (const s of window.requiredSlots) {
    if (slots[s]) anchors[s] = slots[s];
  }
  for (const s of window.optionalSlots) {
    if (slots[s]) anchors[s] = slots[s];
  }

  const userPrompt = {
    dayKey,
    fajrHourApprox: fajrH,
    friday,
    window: {
      start: window.startSlot,
      end: window.endSlot,
      hours: window.labels,
      intermediateOnly: window.optionalSlots,
    },
    operatorAnchors: anchors,
    localSeedSlots: seed.slots,
    instructions: [
      "Refine ONLY intermediate hours listed in window.intermediateOnly.",
      "Keep every operatorAnchors hour byte-identical in the output.",
      "Start from localSeedSlots and apply small realistic adjustments (weather-like, duty pattern), not a rewrite.",
      "Residential dip deeper near fajrHourApprox; industrial feeders almost flat.",
      "Return JSON matching the schema.",
    ],
  };

  try {
    const providerResponse = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.25,
        max_tokens: 4500,
        messages: [
          { role: "system", content: buildSystemPrompt(fajrH, friday) },
          { role: "user", content: JSON.stringify(userPrompt) },
        ],
      }),
    });

    if (!providerResponse.ok) {
      const errText = await providerResponse.text().catch(() => "");
      console.error(`${provider.name} API error`, providerResponse.status, errText);
      // Furnished local fallback
      return res.json({
        success: true,
        data: seed,
        meta: {
          source: "local",
          engine: seed?.meta?.engine || "local-v2",
          reason: "provider_error",
          status: providerResponse.status,
        },
      });
    }

    const data = await providerResponse.json();
    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      "";

    let parsed: any = null;
    try {
      const cleaned = String(content)
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse model JSON — using furnished local seed");
      return res.json({
        success: true,
        data: seed,
        meta: {
          source: "local",
          engine: seed?.meta?.engine || "local-v2",
          reason: "parse_error",
        },
      });
    }

    // Merge: operator/seed anchors locked; intermediate from AI with seed fallback
    const outSlots: Record<string, any> = { ...seed.slots };
    const aiSlots = parsed?.slots || parsed?.data?.slots || {};

    for (const label of window.optionalSlots) {
      const row = aiSlots[label];
      if (!row || typeof row !== "object") continue;

      const amps: Record<string, number> = {};
      FEEDERS.forEach((f) => {
        const raw =
          row.amps?.[f.id] ??
          row.amps?.[String(f.id)] ??
          seed.slots?.[label]?.amps?.[f.id] ??
          0;
        let n = Math.max(0, Math.round(Number(raw) || 0));
        // Guardrail: don't allow AI to drift more than ~35% from local seed
        const seedAmp = Number(seed.slots?.[label]?.amps?.[f.id]);
        if (Number.isFinite(seedAmp) && seedAmp > 0) {
          const lo = Math.floor(seedAmp * 0.65);
          const hi = Math.ceil(seedAmp * 1.35);
          n = Math.max(lo, Math.min(hi, n));
        }
        amps[f.id] = n;
      });

      let bus1 = Number(row.bus1);
      let bus2 = Number(row.bus2);
      if (!Number.isFinite(bus1)) bus1 = seed.slots?.[label]?.bus1;
      if (!Number.isFinite(bus2)) bus2 = seed.slots?.[label]?.bus2;
      // Clamp to practical ceilings
      if (Number.isFinite(bus1)) bus1 = Math.min(36.0, Math.max(30, bus1));
      if (Number.isFinite(bus2)) bus2 = Math.min(35.6, Math.max(30, bus2));

      outSlots[label] = {
        amps,
        bus1: Math.round(Number(bus1) * 10) / 10,
        bus2: Math.round(Number(bus2) * 10) / 10,
        source: Object.fromEntries(FEEDERS.map((f) => [f.id, "predicted"])),
        busSource: { bus1: "predicted", bus2: "predicted" },
      };
    }

    // Force anchors back to seed (operator values)
    for (const label of window.requiredSlots) {
      if (seed.slots[label]) outSlots[label] = seed.slots[label];
    }
    // Also lock any mid anchors the operator filled
    for (const label of window.optionalSlots) {
      if (slots[label]) {
        // Operator mid-anchor: keep seed (which already ingested it as known)
        if (seed.slots[label]?.source) {
          const src = seed.slots[label].source;
          const allAnchor = FEEDERS.every(
            (f) => src[f.id] === "anchor" || src[String(f.id)] === "anchor"
          );
          if (allAnchor) outSlots[label] = seed.slots[label];
        }
      }
    }

    return res.json({
      success: true,
      data: {
        slots: outSlots,
        meta: {
          ...(seed.meta || {}),
          source: provider.name,
          model: provider.model,
          engine: "ai+local-seed-v2",
        },
      },
      meta: { source: provider.name, model: provider.model },
    });
  } catch (err: any) {
    console.error("night-log AI generate error:", err);
    return res.json({
      success: true,
      data: seed,
      meta: {
        source: "local",
        engine: seed?.meta?.engine || "local-v2",
        reason: "exception",
      },
    });
  }
});

export default router;
