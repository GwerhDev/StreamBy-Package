import { StreamByConfig } from '../types';
import { assertPublicEndpoint, checkWorkerEndpoint, WorkerError } from './workers';

// Speech to text, with whichever provider the user connected (an account integration of theirs):
// OpenAI, Deepgram, AssemblyAI, or any service with OpenAI's transcription API (Groq, a
// whisper.cpp or LocalAI server...), at the base URL given. Each answers the text.

export const SPEECH_PROVIDERS = ['openai', 'deepgram', 'assemblyai', 'openai-compatible'] as const;
export type SpeechProvider = typeof SPEECH_PROVIDERS[number];
export const isSpeechProvider = (value: unknown): value is SpeechProvider => (SPEECH_PROVIDERS as readonly unknown[]).includes(value);

/** An OpenAI-compatible service's credential: where it is, its key (if it takes one) and model. */
export interface CompatibleCredential { baseUrl: string; apiKey?: string; model?: string }

/** A speech provider's credential, as it's given: a key; for an OpenAI-compatible one, its base URL too. */
export function checkSpeechCredential(provider: SpeechProvider, value: unknown, config: StreamByConfig): string | CompatibleCredential {
  if (provider !== 'openai-compatible') {
    if (typeof value !== 'string' || !value.trim()) throw new WorkerError('credential must be the API key');
    return value.trim();
  }
  const given = value as Partial<CompatibleCredential> | null;
  if (!given || typeof given !== 'object' || typeof given.baseUrl !== 'string') throw new WorkerError('credential must be { baseUrl, apiKey?, model? }');
  if (given.apiKey !== undefined && typeof given.apiKey !== 'string') throw new WorkerError('apiKey must be a string');
  if (given.model !== undefined && typeof given.model !== 'string') throw new WorkerError('model must be a string');
  // Reached from StreamBy's server: as a worker's endpoint is, never a local or private address.
  return { baseUrl: checkWorkerEndpoint(given.baseUrl, config).replace(/\/$/, ''), apiKey: given.apiKey || undefined, model: given.model || undefined };
}

export interface Audio { bytes: Buffer; fileName: string; contentType: string }
export interface Transcript { text: string; language: string | null }

const failed = async (res: Response, provider: string) => {
  // Its answer stays in the server's log: a provider's error may carry what isn't the user's to see.
  console.error(`❌ StreamBy transcription: ${provider} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`);
  return new WorkerError(`${provider} refused the transcription (${res.status})`, 502);
};

async function openAiLike(provider: string, baseUrl: string, apiKey: string | undefined, model: string, audio: Audio, language?: string): Promise<Transcript> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio.bytes)], { type: audio.contentType }), audio.fileName);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST', redirect: 'error', body: form,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw await failed(res, provider);
  const data: any = await res.json();
  return { text: String(data.text ?? '').trim(), language: data.language ?? language ?? null };
}

async function deepgram(apiKey: string, audio: Audio, language?: string): Promise<Transcript> {
  const query = new URLSearchParams({ smart_format: 'true', ...(language ? { language } : { detect_language: 'true' }) });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
    method: 'POST', redirect: 'error', body: new Uint8Array(audio.bytes),
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': audio.contentType },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw await failed(res, 'Deepgram');
  const data: any = await res.json();
  const channel = data.results?.channels?.[0];
  return { text: String(channel?.alternatives?.[0]?.transcript ?? '').trim(), language: channel?.detected_language ?? language ?? null };
}

async function assemblyAi(apiKey: string, audio: Audio, language: string | undefined, pollMs: number): Promise<Transcript> {
  const headers = { Authorization: apiKey };
  const uploaded = await fetch('https://api.assemblyai.com/v2/upload', { method: 'POST', redirect: 'error', headers, body: new Uint8Array(audio.bytes) });
  if (!uploaded.ok) throw await failed(uploaded, 'AssemblyAI');
  const { upload_url } = await uploaded.json() as any;
  const started = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, ...(language ? { language_code: language } : { language_detection: true }) }),
  });
  if (!started.ok) throw await failed(started, 'AssemblyAI');
  const { id } = await started.json() as any;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`, { headers, redirect: 'error' });
    if (!res.ok) throw await failed(res, 'AssemblyAI');
    const data: any = await res.json();
    if (data.status === 'completed') return { text: String(data.text ?? '').trim(), language: data.language_code ?? language ?? null };
    if (data.status === 'error') throw new WorkerError(`AssemblyAI couldn't transcribe it: ${data.error ?? 'unknown error'}`, 502);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new WorkerError("AssemblyAI didn't finish in time", 504);
}

/** An audio's text, by a user's speech provider, with its credential (as checkSpeechCredential gives it). */
export async function transcribe(
  provider: SpeechProvider, credential: string | CompatibleCredential, audio: Audio,
  options: { language?: string; model?: string; pollMs?: number }, config: StreamByConfig,
): Promise<Transcript> {
  switch (provider) {
    case 'openai':
      return openAiLike('OpenAI', 'https://api.openai.com/v1', credential as string, options.model || 'whisper-1', audio, options.language);
    case 'openai-compatible': {
      const c = credential as CompatibleCredential;
      // Where it resolves now: never the server's own network.
      await assertPublicEndpoint(c.baseUrl, config);
      return openAiLike('The transcription service', c.baseUrl, c.apiKey, options.model || c.model || 'whisper-1', audio, options.language);
    }
    case 'deepgram':
      return deepgram(credential as string, audio, options.language);
    case 'assemblyai':
      return assemblyAi(credential as string, audio, options.language, options.pollMs ?? 3000);
  }
}
