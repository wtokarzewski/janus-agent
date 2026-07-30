/**
 * Local embedding engine using @xenova/transformers.
 * Runs all-MiniLM-L6-v2 (384-dim) locally via ONNX — free, no API keys.
 * Model loads lazily on first call (~23MB download on first run, cached after).
 *
 * IMPORTANT: ONNX/WASM inference can block the event loop.
 * Each embed() call yields to the event loop after inference
 * so that Grammy, timers, and I/O can keep running.
 */

/**
 * Model identity. Part of the embedding cache key — swapping models must not
 * serve vectors produced by the previous one.
 */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

let pipelineInstance: any = null;
let loading: Promise<any> | null = null;

async function getEmbedder() {
  if (pipelineInstance) return pipelineInstance;
  // Deduplicate concurrent loads
  if (!loading) {
    loading = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      // Yield before heavy WASM compilation
      await yieldToEventLoop();
      pipelineInstance = await pipeline('feature-extraction', EMBEDDING_MODEL);
      return pipelineInstance;
    })();
  }
  return loading;
}

/** Yield control to the event loop so I/O, timers, and signals can fire. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  // Yield after inference to prevent starving the event loop
  await yieldToEventLoop();
  return new Float32Array(result.data);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are already normalized
}
