import OpenAI from "openai";
import { trackTokenUsage, checkTokenBudget } from "./token-tracker";

const _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let _currentUserId: string | null = null;
let _currentFeature: string | null = null;

export function setTrackingContext(userId: string, feature: string) {
  _currentUserId = userId;
  _currentFeature = feature;
}

export function clearTrackingContext() {
  _currentUserId = null;
  _currentFeature = null;
}

export async function trackedChatCompletion(
  userId: string,
  feature: string,
  params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.Chat.ChatCompletion> {
  const budgetCheck = await checkTokenBudget(userId);

  if (budgetCheck.degradeToMini && params.model === "gpt-4o") {
    params = { ...params, model: "gpt-4o-mini" };
  }

  const completion = await _openai.chat.completions.create(params);

  if (completion.usage) {
    trackTokenUsage(userId, feature, params.model, completion.usage, {
      degraded: budgetCheck.degradeToMini,
    }).catch((err) => console.error("Token tracking error:", err));
  }

  return completion;
}

export async function trackedStreamingCompletion(
  userId: string,
  feature: string,
  params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
): Promise<{ stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>; trackUsage: (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void }> {
  const budgetCheck = await checkTokenBudget(userId);

  if (budgetCheck.degradeToMini && params.model === "gpt-4o") {
    params = { ...params, model: "gpt-4o-mini" };
  }

  const streamParams = {
    ...params,
    stream: true as const,
    stream_options: { include_usage: true },
  };

  const stream = await _openai.chat.completions.create(streamParams);

  const trackUsage = (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => {
    if (usage) {
      trackTokenUsage(userId, feature, params.model, usage, {
        streaming: true,
        degraded: budgetCheck.degradeToMini,
      }).catch((err) => console.error("Token tracking error:", err));
    }
  };

  return { stream, trackUsage };
}

export async function trackedAudioTranscription(
  userId: string,
  feature: string,
  params: OpenAI.Audio.TranscriptionCreateParams,
): Promise<OpenAI.Audio.Transcription> {
  const transcription = await _openai.audio.transcriptions.create(params);

  trackTokenUsage(userId, feature, "whisper-1", {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }, {
    audioTranscription: true,
  }).catch((err) => console.error("Token tracking error:", err));

  return transcription;
}

export { _openai as openai };
