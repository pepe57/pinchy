// Shared parsing helpers for the OAuth start/callback routes. Both routes
// need to (a) read the raw Cookie header into a name→value map and (b)
// resolve the externally-visible origin behind a reverse proxy. Extracted
// here so the two routes can't drift on these details independently.

/**
 * Parse a raw HTTP Cookie header into a name→value map. Tolerates "=" in
 * values (e.g. base64 padding) and an empty/missing header.
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const cookieHeader = header ?? "";
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return [key, rest.join("=")];
    })
  );
}

/**
 * Resolve the externally-visible origin and whether the request is secure,
 * honoring x-forwarded-proto/host (reverse-proxy aware).
 */
export function resolveForwardedOrigin(request: Request): {
  origin: string;
  isSecure: boolean;
} {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const origin =
    forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : requestUrl.origin;
  const isSecure = (forwardedProto ?? requestUrl.protocol.replace(":", "")) === "https";
  return { origin, isSecure };
}
