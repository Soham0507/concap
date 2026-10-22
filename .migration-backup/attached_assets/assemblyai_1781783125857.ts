import fs from "fs";
import type { DiarizedUtterance, SpeakerMap } from "@shared/schema";

const API_BASE = "https://api.assemblyai.com/v2";

export class AssemblyAIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function hasAssemblyAI(): boolean {
  return !!process.env.ASSEMBLYAI_API_KEY;
}

function authHeaders(): Record<string, string> {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new AssemblyAIError("ASSEMBLYAI_API_KEY not configured");
  return { authorization: key };
}

// Narrow type guard for the AssemblyAI upload response.
interface UploadResponse {
  upload_url: string;
}
function isUploadResponse(v: unknown): v is UploadResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { upload_url?: unknown }).upload_url === "string"
  );
}

async function uploadFile(filePath: string): Promise<string> {
  // Node 20's undici-based fetch rejects an explicit `transfer-encoding`
  // header ("invalid transfer-encoding header"). When we hand it a stream
  // body with duplex: 'half' it will set chunked transfer-encoding itself,
  // so we must not pre-set that header. Providing Content-Length up front
  // also lets undici skip chunked encoding entirely when possible, which
  // AssemblyAI handles more reliably for large files.
  const { size } = await fs.promises.stat(filePath);
  const stream = fs.createReadStream(filePath);
  const init = {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/octet-stream",
      "content-length": String(size),
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" };
  const res = await fetch(`${API_BASE}/upload`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AssemblyAIError(
      `AssemblyAI upload failed: ${res.status} ${text}`,
      res.status,
    );
  }
  const data: unknown = await res.json();
  if (!isUploadResponse(data)) {
    throw new AssemblyAIError("AssemblyAI upload returned no upload_url");
  }
  return data.upload_url;
}

interface TranscriptIdResponse {
  id: string;
}
function isTranscriptIdResponse(v: unknown): v is TranscriptIdResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string"
  );
}

async function requestTranscript(audioUrl: string): Promise<string> {
  const res = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ["universal-2"],
      speaker_labels: true,
      punctuate: true,
      format_text: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AssemblyAIError(
      `AssemblyAI transcript request failed: ${res.status} ${text}`,
      res.status,
    );
  }
  const data: unknown = await res.json();
  if (!isTranscriptIdResponse(data)) {
    throw new AssemblyAIError("AssemblyAI transcript request returned no id");
  }
  return data.id;
}

// Subset of the AssemblyAI transcript-poll payload we actually consume.
interface RawAssemblyUtterance {
  speaker?: string;
  start?: number;
  end?: number;
  text?: string;
  confidence?: number;
}
interface TranscriptPollResponse {
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  utterances?: RawAssemblyUtterance[] | null;
  audio_duration?: number;
  error?: string;
}
function isTranscriptPollResponse(v: unknown): v is TranscriptPollResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { status?: unknown }).status === "string"
  );
}

async function pollTranscript(id: string): Promise<TranscriptPollResponse> {
  const start = Date.now();
  // Allow up to 2 hours of polling for very long files
  const maxMs = 2 * 60 * 60 * 1000;
  let delayMs = 2000;
  while (Date.now() - start < maxMs) {
    const res = await fetch(`${API_BASE}/transcript/${id}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AssemblyAIError(
        `AssemblyAI poll failed: ${res.status} ${text}`,
        res.status,
      );
    }
    const data: unknown = await res.json();
    if (!isTranscriptPollResponse(data)) {
      throw new AssemblyAIError("AssemblyAI poll returned malformed payload");
    }
    if (data.status === "completed") return data;
    if (data.status === "error") {
      throw new AssemblyAIError(
        `AssemblyAI transcription error: ${data.error || "unknown"}`,
      );
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs + 1000, 8000);
  }
  throw new AssemblyAIError("AssemblyAI transcription timed out");
}

export interface DiarizedTranscriptionResult {
  text: string;
  utterances: DiarizedUtterance[];
  audioDurationMs: number;
  participantCount: number;
  uniqueSpeakers: string[];
}

export async function transcribeWithDiarization(
  filePath: string,
): Promise<DiarizedTranscriptionResult> {
  const audioUrl = await uploadFile(filePath);
  const id = await requestTranscript(audioUrl);
  const result = await pollTranscript(id);

  const rawUtterances: RawAssemblyUtterance[] = Array.isArray(result.utterances)
    ? result.utterances
    : [];

  const utterances: DiarizedUtterance[] = rawUtterances.map((u) => ({
    speaker: typeof u.speaker === "string" ? `Speaker ${u.speaker}` : "Speaker ?",
    start: Number(u.start) || 0,
    end: Number(u.end) || 0,
    text: String(u.text || ""),
    confidence: typeof u.confidence === "number" ? u.confidence : undefined,
  }));

  const uniqueSpeakers = Array.from(
    new Set(utterances.map((u) => u.speaker)),
  );

  // Fallback to plain `text` when no utterances were returned (e.g. mono mic)
  const text =
    utterances.length > 0
      ? utterances
          .map((u) => `${u.speaker}: ${u.text}`)
          .join("\n")
      : String(result.text || "");

  const audioDurationMs =
    typeof result.audio_duration === "number"
      ? Math.round(result.audio_duration * 1000)
      : utterances.length > 0
        ? utterances[utterances.length - 1].end
        : 0;

  return {
    text,
    utterances,
    audioDurationMs,
    participantCount: uniqueSpeakers.length,
    uniqueSpeakers,
  };
}

export function computeTalkTimePercents(
  utterances: DiarizedUtterance[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  let grand = 0;
  for (const u of utterances) {
    const dur = Math.max(0, u.end - u.start);
    totals[u.speaker] = (totals[u.speaker] || 0) + dur;
    grand += dur;
  }
  const out: Record<string, number> = {};
  if (grand <= 0) return out;
  for (const [speaker, ms] of Object.entries(totals)) {
    out[speaker] = Math.round((ms / grand) * 1000) / 10;
  }
  return out;
}

export function applySpeakerMap(
  utterances: DiarizedUtterance[],
  map: SpeakerMap | null | undefined,
): DiarizedUtterance[] {
  if (!map) return utterances;
  return utterances.map((u) => {
    const m = map[u.speaker];
    if (m && m.name) return { ...u, speaker: m.name };
    return u;
  });
}
