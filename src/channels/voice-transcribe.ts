/**
 * Voice transcription via Groq Whisper API.
 * Accepts raw audio buffer (OGG/MP3/etc.) and returns transcript text.
 */

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const TIMEOUT_MS = 30_000;

/**
 * Transcribe audio buffer using Groq Whisper API.
 * @param audio — Raw audio bytes (OGG Opus from Telegram voice, MP3 from audio, etc.)
 * @param apiKey — Groq API key
 * @param language — Optional ISO 639-1 language code (e.g. 'pl', 'en')
 * @returns Transcribed text
 */
export async function transcribeVoice(audio: Uint8Array, apiKey: string, language?: string): Promise<string> {
  const form = new FormData();
  const buf = Buffer.from(audio);
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Groq Whisper API error: HTTP ${response.status} ${body.substring(0, 200)}`);
    }

    const data = await response.json() as { text?: string };
    return data.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}
