import type { DiarizedUtterance } from "@shared/schema";

/**
 * Cross-meeting speaker recognition.
 *
 * This module turns each speaker's utterances into a fixed-dimension,
 * L2-normalized "voiceprint" vector that can be matched against a per-user
 * registry of previously-confirmed speakers. The current extractor is a
 * lexical/style fingerprint (unigram + bigram hashing + function-word
 * frequency) — it captures consistent vocabulary and speech patterns and works
 * with no extra dependencies. The vector format is intentionally generic so a
 * real audio embedding (Pyannote / Resemble / AssemblyAI speaker ID) can be
 * swapped in later without changing storage, matching, or UI.
 */

export const VOICEPRINT_DIM = 128;
const MATCH_THRESHOLD = 0.72;
const MIN_SAMPLE_CHARS = 40;

const FUNCTION_WORDS = [
  "i", "you", "we", "they", "he", "she", "it",
  "uh", "um", "like", "actually", "basically", "literally",
  "right", "okay", "ok", "so", "well", "kind", "sort", "really",
  "definitely", "honestly", "obviously", "totally", "anyway",
  "yeah", "yep", "nope", "guys", "folks", "team",
];

function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

export function extractTextEmbedding(text: string): number[] {
  const v = new Array(VOICEPRINT_DIM).fill(0);
  if (!text) return v;
  const normalized = text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ");
  const words = normalized.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return v;

  for (const w of words) {
    v[fnv1a(w) % VOICEPRINT_DIM] += 1;
  }
  for (let i = 0; i < words.length - 1; i++) {
    v[fnv1a(words[i] + "_" + words[i + 1]) % VOICEPRINT_DIM] += 0.5;
  }
  // function-word frequency gives a coarse style signature
  for (const fw of FUNCTION_WORDS) {
    const c = words.filter((w) => w === fw).length;
    if (c > 0) v[fnv1a("fw_" + fw) % VOICEPRINT_DIM] += c * 1.5;
  }
  // utterance-length signal
  const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;
  v[fnv1a("avglen") % VOICEPRINT_DIM] += avgLen;

  return l2normalize(v);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Incrementally merge a new sample into an existing centroid. Both `existing`
 * and `addition` should already be L2-normalized vectors of the same length.
 */
export function mergeEmbeddings(
  existing: number[],
  existingSampleCount: number,
  addition: number[],
): number[] {
  if (!existing || existing.length !== addition.length) return addition;
  const total = Math.max(1, existingSampleCount) + 1;
  const merged = new Array(existing.length);
  for (let i = 0; i < existing.length; i++) {
    merged[i] =
      (existing[i] * existingSampleCount + addition[i]) / total;
  }
  return l2normalize(merged);
}

export interface UtteranceLike {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
}

export interface SpeakerSample {
  speaker: string;
  text: string;
  embedding: number[];
  talkTimeMs: number;
  utteranceCount: number;
}

/**
 * Collapse per-utterance rows into one record per anonymous speaker label,
 * computing the speaker-level embedding and total talk-time.
 */
export function summarizeSpeakers(
  utterances: UtteranceLike[],
): SpeakerSample[] {
  const grouped = new Map<
    string,
    { texts: string[]; talkMs: number; count: number }
  >();
  for (const u of utterances) {
    if (!u?.speaker) continue;
    const g = grouped.get(u.speaker) || { texts: [], talkMs: 0, count: 0 };
    g.texts.push(u.text || "");
    g.talkMs += Math.max(0, (u.end || 0) - (u.start || 0));
    g.count += 1;
    grouped.set(u.speaker, g);
  }
  const out: SpeakerSample[] = [];
  for (const [speaker, g] of Array.from(grouped.entries())) {
    const text = g.texts.join(" ").trim();
    out.push({
      speaker,
      text,
      embedding: extractTextEmbedding(text),
      talkTimeMs: g.talkMs,
      utteranceCount: g.count,
    });
  }
  return out;
}

export interface VoiceprintMatch {
  name: string;
  confidence: number;
  voiceprintId: number;
  similarity: number;
}

/**
 * For each anonymous speaker label in the new transcript, find the best match
 * (if any) against the user's existing voiceprint registry. Speakers with too
 * little dialog to fingerprint reliably are skipped.
 */
export function matchSpeakersToRegistry(
  samples: SpeakerSample[],
  registry: Array<{
    id: number;
    canonicalName: string;
    embedding: number[];
  }>,
  threshold: number = MATCH_THRESHOLD,
): Record<string, VoiceprintMatch> {
  const out: Record<string, VoiceprintMatch> = {};
  if (registry.length === 0) return out;
  for (const s of samples) {
    if (s.text.length < MIN_SAMPLE_CHARS) continue;
    let best: { vp: (typeof registry)[number]; sim: number } | null = null;
    for (const vp of registry) {
      const sim = cosineSimilarity(s.embedding, vp.embedding);
      if (!best || sim > best.sim) best = { vp, sim };
    }
    if (best && best.sim >= threshold) {
      out[s.speaker] = {
        name: best.vp.canonicalName,
        // map similarity (threshold..1) to confidence (0.6..0.99)
        confidence: Math.min(
          0.99,
          0.6 + ((best.sim - threshold) / (1 - threshold)) * 0.39,
        ),
        voiceprintId: best.vp.id,
        similarity: best.sim,
      };
    }
  }
  return out;
}

export function speakerTalkTimeMs(utterances: DiarizedUtterance[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of utterances) {
    out[u.speaker] = (out[u.speaker] || 0) + Math.max(0, u.end - u.start);
  }
  return out;
}
