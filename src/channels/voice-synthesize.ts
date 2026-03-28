/**
 * Voice synthesis via OpenAI TTS API.
 * Returns OGG Opus audio buffer suitable for Telegram sendVoice.
 */

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const TIMEOUT_MS = 30_000;

/**
 * Synthesize text to speech using OpenAI TTS API.
 * @returns Raw audio bytes in OGG Opus format (native Telegram voice format).
 */
export async function synthesizeVoice(
  text: string,
  apiKey: string,
  model = 'tts-1',
  voice = 'nova',
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: 'opus',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS API error: HTTP ${response.status} ${body.substring(0, 200)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}
