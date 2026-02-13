import { logger } from './logger';

export async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`${label} attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: lastError.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  logger.error(`${label} failed after ${maxAttempts} attempts`, { error: lastError?.message });
  throw lastError;
}
