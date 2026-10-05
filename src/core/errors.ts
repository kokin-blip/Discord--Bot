// Persist only known diagnostic codes; arbitrary exception text may contain credentials.
export function diagnosticCode(error: unknown): string {
  if (!(error instanceof Error)) return 'WORKER_OPERATION_FAILED';
  if (/^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)) return error.message;
  if (
    /^(?:NETWORK_UNAVAILABLE|DATA_HTTP_\d{3}):(api\.exchange\.coinbase\.com|paper-api\.alpaca\.markets|data\.alpaca\.markets)$/.test(
      error.message,
    )
  )
    return error.message;
  return 'WORKER_OPERATION_FAILED';
}
