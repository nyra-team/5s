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

interface VLMResult {
  issues: VLMIssue[];
  recommendations: VLMRecommendation[];
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
        text: `Area: "${areaName}". Compare the SUBMITTED photo against the IDEAL reference photo(s). Identify 5S compliance issues and give specific, actionable recommendations. Reference exact locations (left/right/top/bottom/center) of issues visible in the submitted image.`,
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
            'You are a strict 5S auditor. Output ONLY valid JSON. Base statements only on visible evidence. Output format: {"issues":[{"issue":"...","evidence":"...","location":"left/right/top/bottom/center"}],"recommendations":[{"action":"...","why":"...","location":"..."}]}',
        },
        {
          role: "user",
          content,
        },
      ],
    });

    const text = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(text);

    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 5)
        : [],
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

  return {
    embeddingHash: embResult.embedding_hash,
    similarityToIdeal: prediction.similarity,
    aiTotalScore: prediction.total_score,
    aiPillarsJson: prediction.pillars,
    aiRecommendationsJson: vlmResult.recommendations,
    aiIssuesJson: vlmResult.issues,
    modelVersion: prediction.model_version,
    scoringMode: prediction.scoring_mode,
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
