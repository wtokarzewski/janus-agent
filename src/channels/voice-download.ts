/** Stream under a byte cap even if Content-Length is missing or incorrect. */
export async function downloadVoice(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await fetch(url, { signal: workSignal });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Audio download failed'); }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel(); throw new Error('Audio exceeds the file size limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      workSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error('Audio exceeds the file size limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
