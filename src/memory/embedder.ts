/**
 * Local embedding engine using @xenova/transformers.
 * Runs all-MiniLM-L6-v2 (384-dim) locally via ONNX — free, no API keys.
 * Model loads lazily on first call (~23MB download on first run, cached after).
 */

let pipelineInstance: any = null;

async function getEmbedder() {
  if (!pipelineInstance) {
    const { pipeline } = await import('@xenova/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return pipelineInstance;
}

export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already normalized
}
