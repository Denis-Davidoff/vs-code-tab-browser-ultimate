/** Explicit local opt-out shared by authentication, HTTP writes and browser sockets. */
export function originChecksDisabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return (
    environment.LOCAL_DISABLE_ORIGIN_CHECK === "true" &&
    environment.NODE_ENV !== "production"
  );
}
