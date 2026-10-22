/**
 * Enterprise Meeting Intelligence Service.
 *
 * Drives the `/api/meetings/intelligence/*` routes. One call → one processed
 * transcript with both a structured JSON extraction and a rendered MOM.
 *
 * Pipeline:
 *   1. Validate inputs.
 *   2. If transcript > MAX_INLINE_CHARS, split into overlapping chunks.
 *   3. For each chunk → ask the model for a partial extraction.
 *   4. Merge partial extractions into a unified document (dedupe action
 *      items, union risks, concatenate discussion points).
 *   5. Render the MOM markdown deterministically from the merged JSON
 *      (NOT another LLM call — keeps formatting stable across runs).
 *   6. Persist to `meeting_intelligence_documents`.
 *
 * Failure semantics: the row is always written. On model failure the row is
 * stored with `status="failed"` and `error_message` populated so the UI can
 * surface it and the operator can retry.
 */

import OpenAI from "openai";
import crypto from "crypto";
import { db, pool } from "../db";
import {
  meetingIntelligenceDocuments,
  meetingIntelligenceBatches,
  type MeetingIntelligenceDocument,
  type MeetingIntelligenceBatch,
} from "@shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { trackTokenUsage, getModelForBudget } from "./token-tracker";
import { persistMemory } from "./agent-memory";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "sk-placeholder" });

/**
 * Quick sanity check on the OpenAI API key. We treat anything that looks
 * like the placeholder we ship in `.env.example` as "not configured" — that
 * way the user gets a useful 400 from the API up front instead of a
 * background-worker 401 from OpenAI buried in `error_message` fields.
 *
 * Returns null when the key looks usable, or a human-readable reason when
 * it doesn't.
 */
export function describeOpenAIKeyProblem(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!key) {
    return "OPENAI_API_KEY is not set. Add a real OpenAI key to your .env file and restart the server.";
  }
  if (/^sk-placeholder/i.test(key) || /replace-with-real-key/i.test(key)) {
    return "OPENAI_API_KEY is still the placeholder value. Replace it with a real key from https://platform.openai.com/api-keys and restart the server.";
  }
  if (!/^sk-/.test(key)) {
    return "OPENAI_API_KEY doesn't look like a valid OpenAI key (expected to start with 'sk-'). Re-check the value in .env.";
  }
  return null;
}

// Emit one loud line at module load so anyone scrolling the boot log
// notices, instead of finding out per-batch via failed-document rows.
(function announceKeyState() {
  const problem = describeOpenAIKeyProblem();
  if (problem) {
    console.warn(
      "\n⚠️  [meeting-intelligence] " + problem + "\n" +
        "    All transcript-processing requests will be rejected with a 400 until this is fixed.\n",
    );
  }
})();

/** Approx 30k chars ~= 7.5k tokens — well within gpt-4o's 128k context. */
const MAX_INLINE_CHARS = 30_000;
const CHUNK_SIZE = 24_000;
const CHUNK_OVERLAP = 1_500;

export interface ProcessTranscriptInput {
  userId: string;
  transcriptText: string;
  projectName?: string | null;
  department?: string | null;
  meetingSource: string;
  meetingDate?: string | null;
  participants?: string[];
  /** Caller-supplied stable id. If absent, one is generated. */
  transcriptId?: string;
}

interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  status: string;
  /** Verbatim transcript line that produced this action. Optional — older
   *  rows / smaller models may not populate it. */
  source_quote?: string;
}

/**
 * Per-list parallel array of verbatim transcript quotes. `evidence_quotes[k][i]`
 * is the source line for `<k>[i]`. Empty string when the LLM can't cite
 * a single line. Always pad to the length of the parent list so indices
 * stay aligned after dedupe/merge.
 */
interface EvidenceQuotes {
  discussion_points?: string[];
  decisions_taken?: string[];
  risks?: string[];
  pending_clarifications?: string[];
  next_steps?: string[];
}

interface ExtractedDocument {
  meeting_title: string;
  project_name: string;
  meeting_type: string;
  meeting_date: string;
  participants: string[];
  executive_summary: string;
  discussion_points: string[];
  decisions_taken: string[];
  action_items: ActionItem[];
  risks: string[];
  pending_clarifications: string[];
  next_steps: string[];
  /** Parallel verbatim quotes — present when the model returns them. */
  evidence_quotes?: EvidenceQuotes;
  confidence_score: number;
}

const SYSTEM_PROMPT = `You are an Enterprise Meeting Intelligence AI Agent.

You process meeting transcripts from Zoom, Microsoft Teams, Google Meet,
Slack, Discord, email, recordings, and PDF/DOCX/TXT exports.

OBJECTIVES
- Understand meeting context
- Detect project / business domain
- Extract decisions, action items, blockers, risks
- Normalise inconsistent conversation formats
- Handle noisy, incomplete, multi-speaker transcripts
- NEVER hallucinate

PROCESSING RULES
1. Clean the transcript: remove filler words, duplicate statements, system
   noise. Normalise sentence structure.
2. Preserve technical terminology, business decisions, customer names,
   dates, commitments, ownership.
3. Do NOT hallucinate. If a value is missing, mark it:
     - Owner missing  → "Pending"
     - Deadline missing → "Pending"
     - Unclear statement → "Needs Clarification"
4. Detect: meeting title, meeting type, executive summary, key discussion
   points, decisions taken, risks, action items (task / owner / deadline /
   status), pending clarifications, escalations, dependencies, follow-ups.

OUTPUT FORMAT (STRICT)
Return ONLY a single JSON object that matches this shape exactly. No prose,
no markdown fences, no commentary.

{
  "meeting_title": "",
  "project_name": "",
  "meeting_type": "",
  "meeting_date": "",
  "participants": [],
  "executive_summary": "",
  "discussion_points": [],
  "decisions_taken": [],
  "action_items": [
    { "task": "", "owner": "", "deadline": "", "status": "Open", "source_quote": "" }
  ],
  "risks": [],
  "pending_clarifications": [],
  "next_steps": [],
  "evidence_quotes": {
    "discussion_points": [],
    "decisions_taken": [],
    "risks": [],
    "pending_clarifications": [],
    "next_steps": []
  },
  "confidence_score": 0.00
}

EVIDENCE QUOTES (REQUIRED for traceability)
For every list-style field below, you MUST also populate the parallel array in "evidence_quotes" with the verbatim transcript line that produced each entry. The arrays MUST be the same length and aligned by index:
  - discussion_points       ↔ evidence_quotes.discussion_points
  - decisions_taken         ↔ evidence_quotes.decisions_taken
  - risks                   ↔ evidence_quotes.risks
  - pending_clarifications  ↔ evidence_quotes.pending_clarifications
  - next_steps              ↔ evidence_quotes.next_steps
For each action_item, populate its own "source_quote" field with the verbatim line that produced it.

Rules for evidence quotes:
  - Each quote MUST appear verbatim in the input transcript — copy the exact text, including punctuation. Do NOT paraphrase.
  - If you cannot find a single verbatim line that supports an entry (e.g. the entry summarises across multiple lines), set the corresponding evidence_quotes entry to an empty string "". Never invent a quote.
  - Keep the arrays the same length as the parent list — pad with "" where needed.
  - Speaker tags ("Naveen:") may be included or excluded; both are acceptable as long as the body text appears verbatim in the source.
DO NOT skip evidence_quotes — downstream UI uses them to link each extracted item back to the source transcript.

ENTERPRISE REQUIREMENTS
- Professional business language
- Consistent formatting
- ERP / CRM / Manufacturing terminology where appropriate
- Output must be machine-parseable JSON (no trailing commas, no comments)
- confidence_score is a float 0.0–1.0 reflecting your certainty in the
  extraction; lower it when the transcript is noisy or incomplete.`;

const CHUNK_INSTRUCTION = `This is one CHUNK of a longer transcript. Extract
only what is present in this chunk. Other chunks will be merged with yours
later. Use the same JSON shape. Set confidence_score for this chunk only.`;

/** Generate a stable, opaque transcript id. */
function generateTranscriptId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `TRX-${ts}-${rand}`;
}

/** Split a long transcript into overlapping chunks. */
function chunkTranscript(text: string): string[] {
  if (text.length <= MAX_INLINE_CHARS) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + CHUNK_SIZE, text.length);
    chunks.push(text.slice(i, end));
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/** Call the model on a single transcript (or chunk). */
async function extractFromText(
  userId: string,
  text: string,
  metadata: ProcessTranscriptInput,
  isChunk: boolean,
): Promise<{
  extraction: ExtractedDocument;
  rawContent: string;
  usage: any;
  model: string;
}> {
  const model = await getModelForBudget(userId, "gpt-4o").catch(() => "gpt-4o");

  const userBlock = [
    isChunk ? CHUNK_INSTRUCTION : "",
    "Metadata (caller-supplied — use as ground truth where provided):",
    JSON.stringify(
      {
        project_name: metadata.projectName ?? null,
        department: metadata.department ?? null,
        meeting_source: metadata.meetingSource,
        meeting_date: metadata.meetingDate ?? null,
        participants: metadata.participants ?? [],
      },
      null,
      2,
    ),
    "",
    "Transcript:",
    "```",
    text,
    "```",
  ]
    .filter(Boolean)
    .join("\n");

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userBlock },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 4000,
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed: ExtractedDocument;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The strict JSON instruction usually works, but if the model breaks
    // format we want a structured failure not a thrown exception.
    throw new Error("Model returned non-JSON output");
  }

  return {
    extraction: normaliseExtraction(parsed, metadata),
    rawContent: raw,
    usage: completion.usage,
    model,
  };
}

/** Ensure every required field is present and typed correctly. */
function normaliseExtraction(
  raw: any,
  metadata: ProcessTranscriptInput,
): ExtractedDocument {
  // Drop entries that aren't non-blank strings, but capture indices we kept
  // so we can pair down the matching evidence-quote array to the same shape.
  const pickStrings = (
    v: any,
  ): { values: string[]; keptIndices: number[] } => {
    if (!Array.isArray(v)) return { values: [], keptIndices: [] };
    const values: string[] = [];
    const keptIndices: number[] = [];
    v.forEach((x, i) => {
      if (typeof x === "string" && x.trim()) {
        values.push(x);
        keptIndices.push(i);
      }
    });
    return { values, keptIndices };
  };

  // Pad / trim a parallel quote array so its indices line up with the
  // already-filtered parent list. Items the model didn't quote get "".
  const alignQuotes = (
    quotes: any,
    keptIndices: number[],
  ): string[] => {
    if (!Array.isArray(quotes)) return keptIndices.map(() => "");
    return keptIndices.map((i) =>
      typeof quotes[i] === "string" ? String(quotes[i]) : "",
    );
  };

  const dp = pickStrings(raw.discussion_points);
  const dt = pickStrings(raw.decisions_taken);
  const rk = pickStrings(raw.risks);
  const pc = pickStrings(raw.pending_clarifications);
  const ns = pickStrings(raw.next_steps);

  const rawQuotes = raw.evidence_quotes ?? {};
  const evidence_quotes: EvidenceQuotes = {
    discussion_points: alignQuotes(rawQuotes.discussion_points, dp.keptIndices),
    decisions_taken: alignQuotes(rawQuotes.decisions_taken, dt.keptIndices),
    risks: alignQuotes(rawQuotes.risks, rk.keptIndices),
    pending_clarifications: alignQuotes(rawQuotes.pending_clarifications, pc.keptIndices),
    next_steps: alignQuotes(rawQuotes.next_steps, ns.keptIndices),
  };

  const actionItems: ActionItem[] = Array.isArray(raw.action_items)
    ? raw.action_items
        .filter((a: any) => a && typeof a === "object")
        .map((a: any) => ({
          task: String(a.task ?? "").trim() || "Needs Clarification",
          owner: String(a.owner ?? "").trim() || "Pending",
          deadline: String(a.deadline ?? "").trim() || "Pending",
          status: String(a.status ?? "Open").trim(),
          source_quote:
            typeof a.source_quote === "string" ? a.source_quote : "",
        }))
    : [];

  const confidence = Number(raw.confidence_score);
  return {
    meeting_title: String(raw.meeting_title ?? "").trim() || "Untitled Meeting",
    project_name:
      String(raw.project_name ?? metadata.projectName ?? "").trim() ||
      "Unspecified",
    meeting_type: String(raw.meeting_type ?? "").trim() || "General",
    meeting_date:
      String(raw.meeting_date ?? metadata.meetingDate ?? "").trim() ||
      "Pending",
    participants: pickStrings(raw.participants).values.length
      ? pickStrings(raw.participants).values
      : metadata.participants ?? [],
    executive_summary: String(raw.executive_summary ?? "").trim(),
    discussion_points: dp.values,
    decisions_taken: dt.values,
    action_items: actionItems,
    risks: rk.values,
    pending_clarifications: pc.values,
    next_steps: ns.values,
    evidence_quotes,
    confidence_score:
      Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
        ? confidence
        : 0.5,
  };
}

/** Merge N partial extractions (from chunks) into one document. */
function mergeExtractions(
  parts: ExtractedDocument[],
  metadata: ProcessTranscriptInput,
): ExtractedDocument {
  if (parts.length === 1) return parts[0];

  const dedupeStrings = (xs: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
      const k = x.toLowerCase().trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(x);
      }
    }
    return out;
  };

  /**
   * Dedupe a string list and the parallel evidence-quote arrays from each
   * chunk in lock-step. Returns the deduped list + the matching quote
   * array so the final document keeps index alignment.
   *
   *   chunkLists  = [parts[i][field]                       for i in 0..n]
   *   chunkQuotes = [parts[i].evidence_quotes?.[field] ?? []  for i in 0..n]
   */
  const dedupeWithQuotes = (
    chunkLists: string[][],
    chunkQuotes: string[][],
  ): { items: string[]; quotes: string[] } => {
    const seen = new Set<string>();
    const items: string[] = [];
    const quotes: string[] = [];
    chunkLists.forEach((list, i) => {
      const q = chunkQuotes[i] || [];
      list.forEach((x, j) => {
        const k = (x || "").toLowerCase().trim();
        if (k && !seen.has(k)) {
          seen.add(k);
          items.push(x);
          quotes.push(typeof q[j] === "string" ? q[j] : "");
        }
      });
    });
    return { items, quotes };
  };

  const dedupeActions = (xs: ActionItem[]) => {
    const seen = new Set<string>();
    const out: ActionItem[] = [];
    for (const a of xs) {
      const k = `${a.task.toLowerCase().trim()}|${a.owner.toLowerCase().trim()}`;
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(a);
      }
    }
    return out;
  };

  // Pick the longest / most informative summary across chunks.
  const bestSummary = parts
    .map((p) => p.executive_summary || "")
    .reduce((a, b) => (b.length > a.length ? b : a), "");

  // Average confidence across chunks.
  const avgConfidence =
    parts.reduce((s, p) => s + p.confidence_score, 0) / parts.length;

  // Dedupe each list together with its parallel quote array, so the final
  // document keeps source-quote alignment across chunked extractions.
  const dp = dedupeWithQuotes(
    parts.map((p) => p.discussion_points),
    parts.map((p) => p.evidence_quotes?.discussion_points ?? []),
  );
  const dt = dedupeWithQuotes(
    parts.map((p) => p.decisions_taken),
    parts.map((p) => p.evidence_quotes?.decisions_taken ?? []),
  );
  const rk = dedupeWithQuotes(
    parts.map((p) => p.risks),
    parts.map((p) => p.evidence_quotes?.risks ?? []),
  );
  const pc = dedupeWithQuotes(
    parts.map((p) => p.pending_clarifications),
    parts.map((p) => p.evidence_quotes?.pending_clarifications ?? []),
  );
  const ns = dedupeWithQuotes(
    parts.map((p) => p.next_steps),
    parts.map((p) => p.evidence_quotes?.next_steps ?? []),
  );

  return {
    meeting_title: parts.find((p) => p.meeting_title !== "Untitled Meeting")
      ?.meeting_title ?? parts[0].meeting_title,
    project_name:
      metadata.projectName ?? parts[0].project_name ?? "Unspecified",
    meeting_type: parts.find((p) => p.meeting_type !== "General")
      ?.meeting_type ?? parts[0].meeting_type,
    meeting_date:
      metadata.meetingDate ?? parts.find((p) => p.meeting_date !== "Pending")
        ?.meeting_date ?? "Pending",
    participants: dedupeStrings(parts.flatMap((p) => p.participants)),
    executive_summary: bestSummary,
    discussion_points: dp.items,
    decisions_taken: dt.items,
    action_items: dedupeActions(parts.flatMap((p) => p.action_items)),
    risks: rk.items,
    pending_clarifications: pc.items,
    next_steps: ns.items,
    evidence_quotes: {
      discussion_points: dp.quotes,
      decisions_taken: dt.quotes,
      risks: rk.quotes,
      pending_clarifications: pc.quotes,
      next_steps: ns.quotes,
    },
    confidence_score: Math.round(avgConfidence * 100) / 100,
  };
}

/** Render the structured doc to a deterministic Markdown MOM. */
function renderMarkdown(doc: ExtractedDocument): string {
  const lines: string[] = [];

  // Each item is rendered with its source quote (when present) on the
  // next line, indented + italicised so it reads as a citation. The UI
  // also renders the rich version; this Markdown is for copy/download.
  const renderBulletWithQuote = (items: string[], quotes?: string[]) => {
    if (!items.length) {
      lines.push("_None._");
      return;
    }
    items.forEach((it, i) => {
      lines.push(`- ${it}`);
      const q = quotes?.[i];
      if (q && q.trim()) {
        lines.push(`  > *Source: "${q.replace(/\n/g, " ").trim()}"*`);
      }
    });
  };

  lines.push(`# Minutes of Meeting (MOM)`);
  lines.push("");
  lines.push(`**Meeting Title:** ${doc.meeting_title}`);
  lines.push(`**Project:** ${doc.project_name}`);
  lines.push(`**Meeting Type:** ${doc.meeting_type}`);
  lines.push(`**Date:** ${doc.meeting_date}`);
  lines.push(
    `**Participants:** ${doc.participants.length ? doc.participants.join(", ") : "Pending"}`,
  );
  lines.push("");
  lines.push(`## Executive Summary`);
  lines.push(doc.executive_summary || "_No summary extracted._");
  lines.push("");
  lines.push(`## Key Discussion Points`);
  renderBulletWithQuote(
    doc.discussion_points,
    doc.evidence_quotes?.discussion_points,
  );
  lines.push("");
  lines.push(`## Decisions Taken`);
  renderBulletWithQuote(
    doc.decisions_taken,
    doc.evidence_quotes?.decisions_taken,
  );
  lines.push("");
  lines.push(`## Action Items`);
  if (doc.action_items.length) {
    lines.push(`| Task | Owner | Deadline | Status |`);
    lines.push(`|------|-------|----------|--------|`);
    for (const a of doc.action_items) {
      lines.push(
        `| ${a.task.replace(/\|/g, "\\|")} | ${a.owner} | ${a.deadline} | ${a.status} |`,
      );
    }
    // Action-item source quotes go right under the table as a bulleted
    // citation list so the table itself stays clean.
    const cited = doc.action_items
      .map((a, i) => (a.source_quote ? { i, q: a.source_quote, t: a.task } : null))
      .filter(Boolean) as Array<{ i: number; q: string; t: string }>;
    if (cited.length) {
      lines.push("");
      lines.push(`*Sources for the above actions:*`);
      for (const c of cited) {
        lines.push(`- **${c.t}:** *"${c.q.replace(/\n/g, " ").trim()}"*`);
      }
    }
  } else {
    lines.push("_None._");
  }
  lines.push("");
  lines.push(`## Risks`);
  renderBulletWithQuote(doc.risks, doc.evidence_quotes?.risks);
  lines.push("");
  lines.push(`## Pending Clarifications`);
  renderBulletWithQuote(
    doc.pending_clarifications,
    doc.evidence_quotes?.pending_clarifications,
  );
  lines.push("");
  lines.push(`## Next Steps`);
  renderBulletWithQuote(doc.next_steps, doc.evidence_quotes?.next_steps);
  lines.push("");
  lines.push(
    `---\n\n_Confidence: ${(doc.confidence_score * 100).toFixed(0)}%_`,
  );
  return lines.join("\n");
}

/** Public entry point. */
/**
 * Run extraction on a row that already exists in the documents table (either
 * because the synchronous endpoint just inserted it, or because the queue
 * worker just claimed it). Always returns a row reflecting the terminal
 * state — never throws.
 */
async function runExtractionOnRow(
  row: MeetingIntelligenceDocument,
): Promise<MeetingIntelligenceDocument> {
  try {
    const chunks = chunkTranscript(row.transcriptText);
    const metadataForMerge: ProcessTranscriptInput = {
      userId: row.userId,
      transcriptText: row.transcriptText,
      projectName: row.projectName,
      department: row.department,
      meetingSource: row.meetingSource,
      meetingDate: row.meetingDate,
      participants: row.participants ?? [],
      transcriptId: row.transcriptId,
    };

    const partials: ExtractedDocument[] = [];
    let totalUsage = { input: 0, output: 0, total: 0 };
    let modelUsed = "gpt-4o";
    for (const chunk of chunks) {
      const { extraction, usage, model } = await extractFromText(
        row.userId,
        chunk,
        metadataForMerge,
        chunks.length > 1,
      );
      partials.push(extraction);
      modelUsed = model;
      if (usage) {
        totalUsage.input += usage.prompt_tokens ?? 0;
        totalUsage.output += usage.completion_tokens ?? 0;
        totalUsage.total += usage.total_tokens ?? 0;
      }
    }

    const merged = mergeExtractions(partials, metadataForMerge);
    const markdown = renderMarkdown(merged);

    const [updated] = await db
      .update(meetingIntelligenceDocuments)
      .set({
        meetingTitle: merged.meeting_title,
        documentJson: merged as any,
        documentMarkdown: markdown,
        confidenceScore: merged.confidence_score,
        chunkCount: chunks.length,
        status: "completed",
        errorMessage: null,
        tokenUsage: {
          inputTokens: totalUsage.input,
          outputTokens: totalUsage.output,
          totalTokens: totalUsage.total,
          model: modelUsed,
        },
        updatedAt: new Date(),
      })
      .where(eq(meetingIntelligenceDocuments.id, row.id))
      .returning();

    trackTokenUsage(
      row.userId,
      "meeting-intelligence",
      modelUsed,
      {
        prompt_tokens: totalUsage.input,
        completion_tokens: totalUsage.output,
        total_tokens: totalUsage.total,
      } as any,
    ).catch(() => undefined);

    void persistMemory({
      ctx: {
        userId: row.userId,
        agentName: "meeting-intelligence",
        retrieve: false,
        metadata: { transcriptId: row.transcriptId, projectName: row.projectName },
      },
      userQuery: `Process transcript ${row.transcriptId} from ${row.meetingSource}`,
      agentResponse: markdown,
    });

    return updated;
  } catch (err: any) {
    const message = err?.message ? String(err.message).slice(0, 1000) : "Unknown error";
    console.error(`[meeting-intelligence] processing failed:`, message);
    const [failed] = await db
      .update(meetingIntelligenceDocuments)
      .set({
        status: "failed",
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(meetingIntelligenceDocuments.id, row.id))
      .returning();
    return failed;
  }
}

/**
 * Synchronous single-transcript path. Inserts a row in 'processing', runs the
 * extraction inline, returns the terminal row. Used by the immediate-feedback
 * UI flow.
 */
export async function processTranscript(
  input: ProcessTranscriptInput,
): Promise<MeetingIntelligenceDocument> {
  if (!input.transcriptText || input.transcriptText.trim().length < 20) {
    throw new Error("Transcript is too short");
  }

  const transcriptId = input.transcriptId || generateTranscriptId();
  const [row] = await db
    .insert(meetingIntelligenceDocuments)
    .values({
      userId: input.userId,
      transcriptId,
      projectName: input.projectName ?? null,
      department: input.department ?? null,
      meetingSource: input.meetingSource,
      meetingDate: input.meetingDate ?? null,
      meetingTitle: null,
      participants: input.participants ?? [],
      transcriptText: input.transcriptText,
      status: "processing",
      attempts: 1,
      claimedAt: new Date(),
    })
    .returning();

  return runExtractionOnRow(row);
}

// ────────────────────────────────────────────────────────────────────────
// Bulk enqueue + queue worker — Postgres-backed.
//
// Rather than pulling in a Redis-backed queue (BullMQ et al.) we lean on
// the database we already have. The trick is `SELECT … FOR UPDATE SKIP
// LOCKED` — Postgres lets concurrent workers claim distinct rows without
// blocking each other, which is exactly what an in-memory queue gives you,
// minus the extra process.
// ────────────────────────────────────────────────────────────────────────

export interface BulkTranscript {
  transcriptText: string;
  transcriptId?: string;
  projectName?: string | null;
  department?: string | null;
  meetingSource?: string;
  meetingDate?: string | null;
  participants?: string[];
}

export interface EnqueueBulkInput {
  userId: string;
  label?: string;
  defaultMeetingSource?: string;
  transcripts: BulkTranscript[];
  metadata?: Record<string, any>;
}

/**
 * Enqueue many transcripts as a single batch. Each transcript becomes a row
 * with status='queued'; the worker drains the queue separately.
 *
 * Returns the freshly-created batch row plus the count actually enqueued
 * (transcripts shorter than the minimum length are silently skipped).
 */
export async function enqueueBulkTranscripts(input: EnqueueBulkInput): Promise<{
  batch: MeetingIntelligenceBatch;
  enqueued: number;
  skipped: number;
}> {
  const cleaned = (input.transcripts || []).filter(
    (t) =>
      typeof t?.transcriptText === "string" &&
      t.transcriptText.trim().length >= 20,
  );
  const skipped = (input.transcripts?.length ?? 0) - cleaned.length;

  // Create the batch first so doc rows can reference it.
  const [batch] = await db
    .insert(meetingIntelligenceBatches)
    .values({
      userId: input.userId,
      label: input.label || null,
      status: cleaned.length === 0 ? "completed" : "queued",
      totalCount: cleaned.length,
      completedCount: 0,
      failedCount: 0,
      metadata: input.metadata || null,
    })
    .returning();

  if (cleaned.length === 0) {
    return { batch, enqueued: 0, skipped };
  }

  // Batch-insert all queued docs in chunks of 200 to keep parameter counts
  // reasonable (some Postgres drivers cap parameters per statement).
  const INSERT_CHUNK = 200;
  for (let i = 0; i < cleaned.length; i += INSERT_CHUNK) {
    const slice = cleaned.slice(i, i + INSERT_CHUNK);
    await db.insert(meetingIntelligenceDocuments).values(
      slice.map((t) => ({
        userId: input.userId,
        batchId: batch.id,
        transcriptId: t.transcriptId || generateTranscriptId(),
        projectName: t.projectName ?? null,
        department: t.department ?? null,
        meetingSource:
          t.meetingSource || input.defaultMeetingSource || "Other",
        meetingDate: t.meetingDate ?? null,
        meetingTitle: null,
        participants: t.participants ?? [],
        transcriptText: t.transcriptText,
        status: "queued" as const,
      })),
    );
  }

  return { batch, enqueued: cleaned.length, skipped };
}

/**
 * Claim a single queued row using FOR UPDATE SKIP LOCKED. Returns the
 * claimed row (status flipped to 'processing') or null when the queue is
 * empty. Safe to call concurrently from multiple workers / processes —
 * Postgres guarantees only one caller gets each row.
 */
async function claimNextQueuedRow(): Promise<MeetingIntelligenceDocument | null> {
  // We need a single statement that claims-and-returns. CTE keeps it atomic.
  const result = await pool.query<MeetingIntelligenceDocument>(
    `WITH claimed AS (
       SELECT id
       FROM meeting_intelligence_documents
       WHERE status = 'queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE meeting_intelligence_documents d
        SET status = 'processing',
            claimed_at = NOW(),
            attempts = d.attempts + 1,
            updated_at = NOW()
       FROM claimed
      WHERE d.id = claimed.id
      RETURNING d.*`,
  );
  const row = (result.rows[0] as any) ?? null;
  if (!row) return null;
  // pg returns snake_case columns; Drizzle's typed select returns camelCase.
  // Normalise so the rest of the service can use the typed shape uniformly.
  return {
    id: row.id,
    userId: row.user_id,
    batchId: row.batch_id,
    transcriptId: row.transcript_id,
    projectName: row.project_name,
    department: row.department,
    meetingSource: row.meeting_source,
    meetingDate: row.meeting_date,
    meetingTitle: row.meeting_title,
    participants: row.participants,
    transcriptText: row.transcript_text,
    documentJson: row.document_json,
    documentMarkdown: row.document_markdown,
    confidenceScore: row.confidence_score,
    status: row.status,
    errorMessage: row.error_message,
    chunkCount: row.chunk_count,
    tokenUsage: row.token_usage,
    claimedAt: row.claimed_at,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * After a document terminal-state transition, roll up the result into the
 * parent batch row (if any). The rollup is denormalised so the UI can show
 * batch progress with a single SELECT instead of an aggregate query per poll.
 */
async function rollUpBatchProgress(batchId: number | null): Promise<void> {
  if (!batchId) return;
  // One statement updates the counts and, when everything's settled, picks a
  // terminal status:
  //   • all completed, no failures  → 'completed'
  //   • mixed (some completed, some failed) → 'completed' (still a terminal
  //                                            state; per-doc rows show
  //                                            what actually happened)
  //   • everything failed, none completed → 'failed' (so the UI doesn't
  //                                          claim success)
  //   • still pending → 'running' (or keeps the prior status)
  await pool.query(
    `WITH stats AS (
       SELECT
         COUNT(*) FILTER (WHERE status = 'completed') AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
         COUNT(*) FILTER (WHERE status IN ('queued', 'processing')) AS pending
       FROM meeting_intelligence_documents
       WHERE batch_id = $1
     )
     UPDATE meeting_intelligence_batches b
        SET completed_count = stats.completed,
            failed_count    = stats.failed,
            status = CASE
              WHEN stats.pending  > 0 THEN 'running'
              WHEN stats.failed   > 0 AND stats.completed = 0 THEN 'failed'
              ELSE 'completed'
            END,
            completed_at = CASE
              WHEN stats.pending = 0 AND b.completed_at IS NULL THEN NOW()
              ELSE b.completed_at
            END,
            updated_at = NOW()
       FROM stats
      WHERE b.id = $1`,
    [batchId],
  );
}

/** Reset rows stuck in 'processing' (server crashed mid-run) back to 'queued'. */
async function reapStuckClaims(staleAfterSeconds = 600): Promise<number> {
  const result = await pool.query(
    `UPDATE meeting_intelligence_documents
        SET status = 'queued',
            claimed_at = NULL,
            updated_at = NOW()
      WHERE status = 'processing'
        AND claimed_at IS NOT NULL
        AND claimed_at < NOW() - ($1 || ' seconds')::interval
        AND attempts < 3
      RETURNING id`,
    [staleAfterSeconds],
  );
  return result.rowCount ?? 0;
}

/**
 * Singleton worker that drains the queued documents.
 *
 *   const worker = startIntelligenceWorker({ concurrency: 5 });
 *   await worker.stop(); // graceful — finishes in-flight rows, then exits
 *
 * Behaviour:
 *   - At most `concurrency` rows are processed in parallel.
 *   - When the queue empties, the worker sleeps `pollIntervalMs` and tries
 *     again. There's no busy-loop.
 *   - Stuck rows (processing for > 10 min, < 3 attempts) are reaped back
 *     to 'queued' on every poll so a crashed server doesn't strand work.
 *   - `stop()` waits for in-flight processing to settle.
 */
export interface IntelligenceWorkerHandle {
  stop: () => Promise<void>;
  status: () => { running: boolean; inFlight: number };
}

export interface StartWorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  staleClaimSeconds?: number;
}

let activeWorker: IntelligenceWorkerHandle | null = null;

export function startIntelligenceWorker(
  opts: StartWorkerOptions = {},
): IntelligenceWorkerHandle {
  if (activeWorker) {
    // Idempotent — multiple calls during boot return the same singleton.
    return activeWorker;
  }
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const pollIntervalMs = Math.max(500, opts.pollIntervalMs ?? 3_000);
  const staleClaimSeconds = Math.max(60, opts.staleClaimSeconds ?? 600);

  let running = true;
  let inFlight = 0;
  const inFlightPromises = new Set<Promise<void>>();

  const processOne = async () => {
    try {
      const row = await claimNextQueuedRow();
      if (!row) return false;
      const finished = await runExtractionOnRow(row);
      await rollUpBatchProgress(finished.batchId ?? null);
      return true;
    } catch (err) {
      console.error("[meeting-intelligence-worker] tick error:", err);
      return false;
    }
  };

  const launchUntilFull = async () => {
    while (running && inFlight < concurrency) {
      const slot = (async () => {
        inFlight++;
        try {
          const found = await processOne();
          if (!found) return; // queue drained — caller will sleep
        } finally {
          inFlight--;
        }
      })();
      inFlightPromises.add(slot);
      slot.finally(() => inFlightPromises.delete(slot));
      // Yield so the loop can re-check `running`/`inFlight`.
      await new Promise((r) => setImmediate(r));
    }
  };

  const tick = async () => {
    if (!running) return;
    try {
      const reaped = await reapStuckClaims(staleClaimSeconds);
      if (reaped > 0) {
        console.log(
          `[meeting-intelligence-worker] reaped ${reaped} stuck claim(s)`,
        );
      }
      await launchUntilFull();
    } catch (err) {
      console.error("[meeting-intelligence-worker] poll error:", err);
    }
    if (running) {
      setTimeout(tick, pollIntervalMs);
    }
  };

  console.log(
    `[meeting-intelligence-worker] starting (concurrency=${concurrency}, poll=${pollIntervalMs}ms)`,
  );
  // Kick off the first tick on next-tick so callers see the handle returned
  // synchronously before any DB work runs.
  setImmediate(tick);

  activeWorker = {
    async stop() {
      running = false;
      // Wait for any in-flight processing to settle before resolving.
      await Promise.all(Array.from(inFlightPromises));
      activeWorker = null;
      console.log("[meeting-intelligence-worker] stopped");
    },
    status() {
      return { running, inFlight };
    },
  };
  return activeWorker;
}

/**
 * Re-queue a single completed (or failed) document so the worker re-runs
 * the extraction. Used to backfill documents that were processed before
 * a prompt or extractor change — e.g. before `evidence_quotes` was added.
 *
 * Behaviour:
 *   - Clears the old outputs (documentJson, documentMarkdown, confidence,
 *     errorMessage) so stale data doesn't linger if the next attempt fails.
 *   - Resets attempts back to 0 so the 3-attempt poison-cap doesn't block
 *     legitimate reprocessing of older docs.
 *   - Status is flipped to 'queued'; the worker picks it up on its next tick.
 *   - Ownership check is the caller's responsibility (route does it).
 */
export async function reprocessDocument(opts: {
  userId: string;
  documentId: number;
}): Promise<{ requeued: boolean; documentId: number }> {
  const result = await pool.query(
    `UPDATE meeting_intelligence_documents
        SET status = 'queued',
            document_json = NULL,
            document_markdown = NULL,
            confidence_score = NULL,
            error_message = NULL,
            claimed_at = NULL,
            attempts = 0,
            updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND status IN ('completed', 'failed')
      RETURNING id, batch_id`,
    [opts.documentId, opts.userId],
  );
  if (result.rowCount && result.rowCount > 0) {
    const batchId = (result.rows[0] as any).batch_id;
    if (batchId) {
      // Reopen the parent batch so its rollup reflects work-in-progress.
      await pool.query(
        `UPDATE meeting_intelligence_batches
            SET status = 'running',
                completed_at = NULL,
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [batchId, opts.userId],
      );
    }
    return { requeued: true, documentId: opts.documentId };
  }
  return { requeued: false, documentId: opts.documentId };
}

/**
 * Re-queue all failed documents in a batch (or in the user's whole account
 * when no batchId is passed). The reaper-style approach: just flip
 * status back to 'queued' and reset claimed_at; the worker picks them up on
 * its next tick. Capped at 3 attempts globally — once a row has been tried
 * that many times we leave it failed to avoid infinite poison-message loops.
 */
export async function retryFailedDocuments(opts: {
  userId: string;
  batchId?: number;
}): Promise<{ requeued: number }> {
  const params: any[] = [opts.userId];
  let where = `user_id = $1 AND status = 'failed' AND attempts < 3`;
  if (opts.batchId !== undefined) {
    params.push(opts.batchId);
    where += ` AND batch_id = $2`;
  }
  const result = await pool.query(
    `UPDATE meeting_intelligence_documents
        SET status = 'queued',
            claimed_at = NULL,
            error_message = NULL,
            updated_at = NOW()
      WHERE ${where}
      RETURNING id, batch_id`,
    params,
  );
  const requeued = result.rowCount ?? 0;
  if (requeued > 0) {
    // Re-open the parent batch so its rollup transitions back to running.
    const batchIds = Array.from(
      new Set(result.rows.map((r: any) => r.batch_id).filter((x: any) => x != null)),
    );
    for (const bid of batchIds) {
      await pool.query(
        `UPDATE meeting_intelligence_batches
            SET status = 'queued',
                completed_at = NULL,
                updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [bid, opts.userId],
      );
    }
  }
  return { requeued };
}

/**
 * Aggregate every completed document in a batch into a single combined
 * MOM, with each extracted item carrying a list of source references so
 * the UI can link verbatim quotes back to the originating transcript.
 *
 * Output shape (mirrors a single-doc ExtractedDocument but enriched):
 *
 *   {
 *     batch:    { id, label, status, totalCount, completedCount, … },
 *     sources:  [ { docId, transcriptId, meetingTitle, meetingDate, source } ],
 *     summary: {
 *       discussion_points: [ { text, sources: [{ docId, quote, meetingTitle }] } ],
 *       decisions_taken:   [ … ],
 *       risks:             [ … ],
 *       pending_clarifications: [ … ],
 *       next_steps:        [ … ],
 *       action_items: [ { task, owner, deadline, status, sources: [{ docId, quote, meetingTitle }] } ],
 *       executive_summaries: [ { docId, meetingTitle, summary } ],
 *       confidence: number,
 *       cited_count: number
 *     }
 *   }
 *
 * Dedupe rule: per-list, two items are considered the same when their
 * lowercased trimmed text matches. Duplicate sources are merged into a
 * single item's `sources` array, so "checkout is too complex" mentioned
 * in three calls appears once with three citations attached.
 */
export interface BatchSummaryItem {
  text: string;
  sources: Array<{
    docId: number;
    transcriptId: string;
    meetingTitle: string | null;
    quote: string | null;
  }>;
}

export interface BatchActionSummaryItem {
  task: string;
  owner: string;
  deadline: string;
  status: string;
  sources: Array<{
    docId: number;
    transcriptId: string;
    meetingTitle: string | null;
    quote: string | null;
  }>;
}

export interface BatchSummary {
  batch: MeetingIntelligenceBatch;
  sources: Array<{
    docId: number;
    transcriptId: string;
    meetingTitle: string | null;
    meetingDate: string | null;
    source: string;
  }>;
  summary: {
    discussion_points: BatchSummaryItem[];
    decisions_taken: BatchSummaryItem[];
    risks: BatchSummaryItem[];
    pending_clarifications: BatchSummaryItem[];
    next_steps: BatchSummaryItem[];
    action_items: BatchActionSummaryItem[];
    executive_summaries: Array<{
      docId: number;
      transcriptId: string;
      meetingTitle: string | null;
      summary: string;
    }>;
    confidence: number;
    cited_count: number;
    total_docs: number;
  };
}

export async function getBatchSummary(
  userId: string,
  batchId: number,
): Promise<BatchSummary | null> {
  const data = await getIntelligenceBatch(userId, batchId);
  if (!data) return null;
  const { batch, documents } = data;

  // We only aggregate from completed docs — failed / queued / processing
  // rows contribute nothing useful and would skew counts.
  const completed = documents.filter((d) => d.status === "completed");

  const sources = completed.map((d) => ({
    docId: d.id,
    transcriptId: d.transcriptId,
    meetingTitle: d.meetingTitle,
    meetingDate: d.meetingDate,
    source: d.meetingSource,
  }));

  /**
   * Walk one list across all docs, deduping by lowercased trimmed text.
   * Each unique text accumulates the {docId, quote} pairs that produced it.
   */
  const aggregateList = (
    listKey:
      | "discussion_points"
      | "decisions_taken"
      | "risks"
      | "pending_clarifications"
      | "next_steps",
  ): BatchSummaryItem[] => {
    const acc = new Map<string, BatchSummaryItem>();
    for (const d of completed) {
      const j: any = d.documentJson ?? {};
      const items: string[] = Array.isArray(j[listKey]) ? j[listKey] : [];
      const quotes: string[] = Array.isArray(j.evidence_quotes?.[listKey])
        ? j.evidence_quotes[listKey]
        : [];
      items.forEach((text, i) => {
        if (typeof text !== "string" || !text.trim()) return;
        const key = text.toLowerCase().trim();
        const quote =
          typeof quotes[i] === "string" && quotes[i].trim() ? quotes[i] : null;
        const existing = acc.get(key);
        if (existing) {
          existing.sources.push({
            docId: d.id,
            transcriptId: d.transcriptId,
            meetingTitle: d.meetingTitle,
            quote,
          });
        } else {
          acc.set(key, {
            text,
            sources: [
              {
                docId: d.id,
                transcriptId: d.transcriptId,
                meetingTitle: d.meetingTitle,
                quote,
              },
            ],
          });
        }
      });
    }
    // Sort: items cited in the most transcripts surface first — they're
    // the strongest cross-meeting signals.
    return Array.from(acc.values()).sort(
      (a, b) => b.sources.length - a.sources.length,
    );
  };

  // Action items dedupe by (task + owner) since the same task can be
  // assigned to two different people across meetings without being the
  // same commitment.
  const aggregateActions = (): BatchActionSummaryItem[] => {
    const acc = new Map<string, BatchActionSummaryItem>();
    for (const d of completed) {
      const j: any = d.documentJson ?? {};
      const actions: any[] = Array.isArray(j.action_items) ? j.action_items : [];
      for (const a of actions) {
        if (!a || typeof a !== "object") continue;
        const task = String(a.task ?? "").trim();
        if (!task) continue;
        const owner = String(a.owner ?? "Pending").trim();
        const key = `${task.toLowerCase()}|${owner.toLowerCase()}`;
        const quote =
          typeof a.source_quote === "string" && a.source_quote.trim()
            ? a.source_quote
            : null;
        const existing = acc.get(key);
        if (existing) {
          existing.sources.push({
            docId: d.id,
            transcriptId: d.transcriptId,
            meetingTitle: d.meetingTitle,
            quote,
          });
        } else {
          acc.set(key, {
            task,
            owner,
            deadline: String(a.deadline ?? "Pending").trim(),
            status: String(a.status ?? "Open").trim(),
            sources: [
              {
                docId: d.id,
                transcriptId: d.transcriptId,
                meetingTitle: d.meetingTitle,
                quote,
              },
            ],
          });
        }
      }
    }
    return Array.from(acc.values()).sort(
      (a, b) => b.sources.length - a.sources.length,
    );
  };

  const discussion_points = aggregateList("discussion_points");
  const decisions_taken = aggregateList("decisions_taken");
  const risks = aggregateList("risks");
  const pending_clarifications = aggregateList("pending_clarifications");
  const next_steps = aggregateList("next_steps");
  const action_items = aggregateActions();

  const executive_summaries = completed
    .map((d) => ({
      docId: d.id,
      transcriptId: d.transcriptId,
      meetingTitle: d.meetingTitle,
      summary: String((d.documentJson as any)?.executive_summary ?? "").trim(),
    }))
    .filter((s) => s.summary.length > 0);

  // Count how many extracted items carry at least one cited quote — gives
  // the UI a single "is this trustworthy" number to surface.
  const countCited = (arr: BatchSummaryItem[] | BatchActionSummaryItem[]) =>
    arr.reduce(
      (n, it) => n + (it.sources.some((s) => !!s.quote) ? 1 : 0),
      0,
    );
  const cited_count =
    countCited(discussion_points) +
    countCited(decisions_taken) +
    countCited(risks) +
    countCited(pending_clarifications) +
    countCited(next_steps) +
    countCited(action_items);

  // Confidence is the average of contributing docs' confidence scores.
  const confidence =
    completed.length === 0
      ? 0
      : completed.reduce(
          (s, d) => s + (typeof d.confidenceScore === "number" ? d.confidenceScore : 0.5),
          0,
        ) / completed.length;

  return {
    batch,
    sources,
    summary: {
      discussion_points,
      decisions_taken,
      risks,
      pending_clarifications,
      next_steps,
      action_items,
      executive_summaries,
      confidence,
      cited_count,
      total_docs: completed.length,
    },
  };
}

/** List batches owned by a user. */
export async function listIntelligenceBatches(
  userId: string,
  limit = 50,
): Promise<MeetingIntelligenceBatch[]> {
  return db
    .select()
    .from(meetingIntelligenceBatches)
    .where(eq(meetingIntelligenceBatches.userId, userId))
    .orderBy(desc(meetingIntelligenceBatches.createdAt))
    .limit(limit);
}

/** Fetch a single batch + its documents, scoped to the calling user. */
export async function getIntelligenceBatch(
  userId: string,
  batchId: number,
): Promise<{
  batch: MeetingIntelligenceBatch;
  documents: MeetingIntelligenceDocument[];
} | null> {
  const rows = await db
    .select()
    .from(meetingIntelligenceBatches)
    .where(
      and(
        eq(meetingIntelligenceBatches.id, batchId),
        eq(meetingIntelligenceBatches.userId, userId),
      ),
    )
    .limit(1);
  const batch = rows[0];
  if (!batch) return null;
  const documents = await db
    .select()
    .from(meetingIntelligenceDocuments)
    .where(eq(meetingIntelligenceDocuments.batchId, batchId))
    .orderBy(desc(meetingIntelligenceDocuments.createdAt));
  return { batch, documents };
}

/** List documents for a user (most recent first). */
export async function listIntelligenceDocuments(
  userId: string,
  limit = 50,
): Promise<Array<typeof meetingIntelligenceDocuments.$inferSelect>> {
  return db
    .select()
    .from(meetingIntelligenceDocuments)
    .where(eq(meetingIntelligenceDocuments.userId, userId))
    .orderBy(desc(meetingIntelligenceDocuments.createdAt))
    .limit(limit);
}

/** Fetch a single document by id, scoped to the calling user. */
export async function getIntelligenceDocument(
  userId: string,
  id: number,
): Promise<typeof meetingIntelligenceDocuments.$inferSelect | null> {
  const rows = await db
    .select()
    .from(meetingIntelligenceDocuments)
    .where(
      and(
        eq(meetingIntelligenceDocuments.id, id),
        eq(meetingIntelligenceDocuments.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
