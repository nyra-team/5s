import { openai } from "@workspace/integrations-openai-ai-server";
import { db, idealPhotosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import * as fs from "fs";
import * as path from "path";

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8100";

interface EmbedResult {
  embedding: number[];
  embedding_hash: string;
}

interface PredictResult {
  similarity: number;
  total_score: number;
  pillars: Record<string, number>;
  scoring_mode: string;
  model_version: string;
}

interface VLMIssue {
  issue: string;
  evidence: string;
  location: string;
}

interface VLMRecommendation {
  action: string;
  why: string;
  location: string;
}

interface VLMPillarScores {
  sort: number;
  set: number;
  shine: number;
  standardize: number;
  sustain: number;
}

interface VLMResult {
  issues: VLMIssue[];
  recommendations: VLMRecommendation[];
  pillarScores: VLMPillarScores | null;
}

export interface AIScoringResult {
  embeddingHash: string;
  similarityToIdeal: number;
  aiTotalScore: number;
  aiPillarsJson: Record<string, number>;
  aiRecommendationsJson: VLMRecommendation[];
  aiIssuesJson: VLMIssue[];
  modelVersion: string;
  scoringMode: string;
}

async function callMLService<T>(endpoint: string, body: unknown): Promise<T> {
  const resp = await fetch(`${ML_SERVICE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ML service ${endpoint} failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<T>;
}

function imageToBase64(imagePath: string): string {
  const fullPath = path.resolve(imagePath);
  const buffer = fs.readFileSync(fullPath);
  return buffer.toString("base64");
}

async function embedImage(imagePath: string): Promise<EmbedResult> {
  return callMLService<EmbedResult>("/embed", { image_path: imagePath });
}

async function predictScore(
  areaId: number,
  embedding: number[],
  idealEmbeddings: number[][]
): Promise<PredictResult> {
  return callMLService<PredictResult>("/predict", {
    area_id: areaId,
    embedding,
    ideal_embeddings: idealEmbeddings,
  });
}

async function getVLMRecommendations(
  submissionImagePath: string,
  idealImagePaths: string[],
  areaName: string
): Promise<VLMResult> {
  try {
    const submissionBase64 = imageToBase64(submissionImagePath);

    const content: any[] = [
      {
        type: "text",
        text: `Area: "${areaName}". Compare the SUBMITTED photo against the IDEAL reference photo(s). Score each of the 5S pillars from 0 (terrible) to 5 (perfect) based on what you see. Also identify specific 5S compliance issues and give actionable recommendations. Reference exact locations (left/right/top/bottom/center) of issues visible in the submitted image. Be strict: a messy, cluttered, or disorganized area should receive low scores (0-2). Only give high scores (4-5) when the area is clearly clean, organized, and well-maintained.`,
      },
      {
        type: "text",
        text: "SUBMITTED PHOTO:",
      },
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${submissionBase64}` },
      },
    ];

    for (let i = 0; i < Math.min(idealImagePaths.length, 3); i++) {
      if (fs.existsSync(idealImagePaths[i])) {
        const idealBase64 = imageToBase64(idealImagePaths[i]);
        content.push({
          type: "text",
          text: `IDEAL REFERENCE PHOTO ${i + 1}:`,
        });
        content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${idealBase64}` },
        });
      }
    }

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      response_format: { type: "json_object" },
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            'You are a strict 5S workplace auditor. Output ONLY valid JSON. Be harsh and critical — messiness, clutter, disorganization, and safety hazards should result in low scores. Base statements only on visible evidence. Output format: {"pillar_scores":{"sort":0-5,"set":0-5,"shine":0-5,"standardize":0-5,"sustain":0-5},"issues":[{"issue":"...","evidence":"...","location":"left/right/top/bottom/center"}],"recommendations":[{"action":"...","why":"...","location":"..."}]}. Score guide: 0=hazardous/chaotic, 1=very poor, 2=poor, 3=acceptable, 4=good, 5=excellent.',
        },
        {
          role: "user",
          content,
        },
      ],
    });

    const text = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);

    let pillarScores: VLMPillarScores | null = null;
    if (parsed.pillar_scores && typeof parsed.pillar_scores === "object") {
      const ps = parsed.pillar_scores;
      pillarScores = {
        sort: Math.max(0, Math.min(5, Math.round(Number(ps.sort) || 0))),
        set: Math.max(0, Math.min(5, Math.round(Number(ps.set) || 0))),
        shine: Math.max(0, Math.min(5, Math.round(Number(ps.shine) || 0))),
        standardize: Math.max(0, Math.min(5, Math.round(Number(ps.standardize) || 0))),
        sustain: Math.max(0, Math.min(5, Math.round(Number(ps.sustain) || 0))),
      };
    }

    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 5)
        : [],
      pillarScores,
    };
  } catch (err) {
    logger.error({ err }, "VLM recommendation failed, using fallback");
    return getFallbackRecommendations();
  }
}

function getFallbackRecommendations(): VLMResult {
  return {
    issues: [
      {
        issue: "Unable to perform detailed AI analysis",
        evidence: "VLM service unavailable",
        location: "general",
      },
    ],
    recommendations: [
      {
        action: "Ensure all tools are in designated locations",
        why: "Maintains Set in Order (Seiton) standards",
        location: "general",
      },
      {
        action: "Check for any spills or debris on work surfaces",
        why: "Maintains Shine (Seiso) standards",
        location: "general",
      },
      {
        action: "Verify all labels and markings are visible and up to date",
        why: "Maintains Standardize (Seiketsu) standards",
        location: "general",
      },
    ],
    pillarScores: null,
  };
}

export async function scoreSubmission(
  imagePath: string,
  areaId: number,
  areaName: string
): Promise<AIScoringResult> {
  const uploadsDir = path.resolve(process.cwd(), "uploads");
  const fullImagePath = path.join(uploadsDir, path.basename(imagePath));

  let embResult: EmbedResult;
  try {
    embResult = await embedImage(fullImagePath);
  } catch (err) {
    logger.error({ err }, "Failed to embed submission image");
    return {
      embeddingHash: "",
      similarityToIdeal: 0,
      aiTotalScore: 0,
      aiPillarsJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      aiRecommendationsJson: getFallbackRecommendations().recommendations,
      aiIssuesJson: getFallbackRecommendations().issues,
      modelVersion: "error",
      scoringMode: "FALLBACK",
    };
  }

  const idealPhotos = await db
    .select()
    .from(idealPhotosTable)
    .where(eq(idealPhotosTable.areaId, areaId));

  const idealEmbeddings: number[][] = [];
  const idealImagePaths: string[] = [];

  for (const photo of idealPhotos) {
    if (photo.embeddingJson) {
      idealEmbeddings.push(photo.embeddingJson as number[]);
    }
    const idealFullPath = path.join(uploadsDir, path.basename(photo.imageUrl));
    if (fs.existsSync(idealFullPath)) {
      idealImagePaths.push(idealFullPath);

      if (!photo.embeddingJson) {
        try {
          const idealEmb = await embedImage(idealFullPath);
          await db
            .update(idealPhotosTable)
            .set({ embeddingJson: idealEmb.embedding as any })
            .where(eq(idealPhotosTable.id, photo.id));
          idealEmbeddings.push(idealEmb.embedding);
        } catch (err) {
          logger.error({ err, photoId: photo.id }, "Failed to embed ideal photo");
        }
      }
    }
  }

  let prediction: PredictResult;
  try {
    prediction = await predictScore(areaId, embResult.embedding, idealEmbeddings);
  } catch (err) {
    logger.error({ err }, "Failed to predict score");
    prediction = {
      similarity: 0,
      total_score: 0,
      pillars: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      scoring_mode: "FALLBACK",
      model_version: "error",
    };
  }

  let vlmResult: VLMResult;
  try {
    vlmResult = await getVLMRecommendations(fullImagePath, idealImagePaths, areaName);
  } catch (err) {
    logger.error({ err }, "VLM recommendations failed");
    vlmResult = getFallbackRecommendations();
  }

  let finalPillars: Record<string, number>;
  let finalTotal: number;
  let scoringMode: string;

  if (prediction.scoring_mode === "CALIBRATED") {
    finalPillars = prediction.pillars;
    finalTotal = prediction.total_score;
    scoringMode = "CALIBRATED";
  } else if (vlmResult.pillarScores) {
    const vlmPillars = vlmResult.pillarScores;
    const clipSimilarity = prediction.similarity;
    const clipWeight = 0.3;
    const vlmWeight = 0.7;

    const clipNormalized = Math.max(0, Math.min(1, (clipSimilarity - 0.75) / (0.98 - 0.75)));

    finalPillars = {} as Record<string, number>;
    for (const pillar of ["sort", "set", "shine", "standardize", "sustain"] as const) {
      const vlmScore = vlmPillars[pillar];
      const clipAdjusted = clipNormalized * 5;
      const blended = vlmWeight * vlmScore + clipWeight * clipAdjusted;
      finalPillars[pillar] = Math.max(0, Math.min(5, Math.round(blended)));
    }
    finalTotal = Object.values(finalPillars).reduce((a, b) => a + b, 0);
    scoringMode = "VLM_BLENDED";
  } else {
    finalPillars = prediction.pillars;
    finalTotal = prediction.total_score;
    scoringMode = prediction.scoring_mode;
  }

  return {
    embeddingHash: embResult.embedding_hash,
    similarityToIdeal: prediction.similarity,
    aiTotalScore: finalTotal,
    aiPillarsJson: finalPillars,
    aiRecommendationsJson: vlmResult.recommendations,
    aiIssuesJson: vlmResult.issues,
    modelVersion: prediction.model_version,
    scoringMode,
  };
}

export async function trainAreaModel(
  areaId: number,
  embeddings: number[][],
  labels: Record<string, number>[]
): Promise<{ modelVersion: string; samplesUsed: number; mae: number }> {
  const result = await callMLService<{
    model_version: string;
    samples_used: number;
    mae: number;
  }>("/train", {
    area_id: areaId,
    embeddings,
    labels,
  });

  return {
    modelVersion: result.model_version,
    samplesUsed: result.samples_used,
    mae: result.mae,
  };
}
