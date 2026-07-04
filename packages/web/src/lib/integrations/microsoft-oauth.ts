// MICROSOFT_OAUTH_BASE_URL allows E2E tests to redirect OAuth token refresh calls
// to a local mock server instead of https://login.microsoftonline.com/
import { computeExpiresAt } from "./oauth-token";
import { MICROSOFT_OAUTH_SCOPES, OAUTH_PROVIDERS } from "./oauth-providers";

export async function refreshAccessToken(opts: {
  tenantId: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  // Reuse the shared descriptor's tokenUrl() so token-exchange (start/callback)
  // and token-refresh (here) can never drift onto different hosts/tenants.
  const tokenUrl = OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: opts.tenantId });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      // Reuse the shared scopes constant so a future scope addition flows
      // through to refresh instead of silently narrowing the refreshed token.
      scope: MICROSOFT_OAUTH_SCOPES,
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(`Microsoft token refresh failed: ${err.error_description ?? res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: computeExpiresAt(data.expires_in),
  };
}
