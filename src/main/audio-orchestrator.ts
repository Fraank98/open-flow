export interface AudioOrchestratorOptions {
  maxDurationMs: number;
  sampleRate: number;
}

export class AudioOrchestrator {
  private chunks: Float32Array[] = [];
  private cachedTotal = 0;
  private readonly maxSamples: number;

  constructor(private readonly opts: AudioOrchestratorOptions) {
    this.maxSamples = Math.floor((opts.maxDurationMs / 1000) * opts.sampleRate);
  }

  appendChunk(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.cachedTotal += chunk.length;
    this.trimToMax();
  }

  reset(): void {
    this.chunks = [];
    this.cachedTotal = 0;
  }

  totalSamples(): number {
    return this.cachedTotal;
  }

  snapshot(): Float32Array {
    const total = this.totalSamples();
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  rms(): number {
    let sum = 0;
    let count = 0;
    for (const c of this.chunks) {
      for (let i = 0; i < c.length; i++) {
        const v = c[i] ?? 0;
        sum += v * v;
        count++;
      }
    }
    if (count === 0) return 0;
    return Math.sqrt(sum / count);
  }

  private trimToMax(): void {
    while (this.totalSamples() > this.maxSamples) {
      const first = this.chunks[0];
      if (!first) break;
      const overflow = this.totalSamples() - this.maxSamples;
      if (overflow >= first.length) {
        this.chunks.shift();
        this.cachedTotal -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        // Must stay exact: snapshot() sizes its buffer from this count.
        this.cachedTotal -= overflow;
        break;
      }
    }
  }
}
