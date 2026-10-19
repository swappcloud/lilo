/** Only counts and booleans may leave the native login diagnostic port. */
export function safeDiagnostic(input) {
  const result = {};
  if (input?.state && ["loading", "interactive", "complete"].includes(input.state)) result.state = input.state;
  for (const key of ["focused", "hidden", "valid", "trustedInput", "submitReached", "inputChanged", "buttonDisabled", "browserEdit", "driverError"]) {
    if (typeof input?.[key] === "boolean") result[key] = input[key];
  }
  for (const key of ["inputs", "filled", "requests", "pending", "status", "failures", "submits", "invalid"]) {
    if (Number.isInteger(input?.[key]) && input[key] >= 0 && input[key] <= 100000) result[key] = input[key];
  }
  return result;
}
