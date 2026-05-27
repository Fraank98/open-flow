/**
 * Fire `ping` every `intervalMs` until the returned stop function is called.
 * Rejections from `ping` are swallowed so one transient failure doesn't kill
 * the loop. Used to keep the long-lived llama-server's Metal pipeline hot — a
 * cold call after idle costs ~2.5s (kernel JIT + power-up) vs ~0.1s warm.
 *
 * @returns a function that cancels the loop.
 */
export function startKeepalive(ping: () => Promise<void>, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void ping().catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}
