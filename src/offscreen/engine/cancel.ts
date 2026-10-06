/** A cancel surfaces as an `AbortError` (like the library's), whoever noticed it first. */

export function cancelledError(): DOMException {
  return new DOMException('The job was cancelled.', 'AbortError');
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledError();
}
