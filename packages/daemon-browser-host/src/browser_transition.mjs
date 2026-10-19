const NAVIGATION_CONTEXT_MESSAGES = new Set([
  "Cannot find context with specified id",
]);

/** Recognize only the two Chromium context-loss errors caused by navigation. */
export function isTransientBrowserTransition(error) {
  if (!(error instanceof Error)) return false;
  const message = error.message.replace(/^(?:page|frame)\.(?:evaluate|evaluateHandle):\s*/, "");
  return NAVIGATION_CONTEXT_MESSAGES.has(message)
    || /^Execution context was destroyed(?: due to navigation|, most likely because of a navigation)\.?$/.test(message);
}
