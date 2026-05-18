import pLimit from 'p-limit'

/** Максимум одновременных обработок webhook-update. */
export const WEBHOOK_CONCURRENCY = 10

const webhookLimit = pLimit(WEBHOOK_CONCURRENCY)

/**
 * Ограничивает параллелизм обработки входящих MAX updates (webhook POST).
 */
export function enqueueUpdate<T>(fn: () => Promise<T>): Promise<T> {
  return webhookLimit(fn)
}
