// auth-direct: browser-flow callback. The user has just bounced through
// Google's or Microsoft's OAuth consent screen; on auth failure we render a
// redirect to /settings, not a JSON 401, so they don't dead-end on raw JSON.
// The withAuth/withAdmin wrappers always return JSON, which doesn't fit here.
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getOAuthSettings, type MicrosoftOAuthSettings } from "@/lib/integrations/oauth-settings";
import { getOAuthProvider, OAUTH_PROVIDERS } from "@/lib/integrations/oauth-providers";
import { encrypt } from "@/lib/encryption";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { redactEmail } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { computeExpiresAt } from "@/lib/integrations/oauth-token";
import { clearIntegrationAuthError } from "@/lib/integrations/auth-state";
import { eq, and } from "drizzle-orm";

/**
 * Try to decode the OAuth state as a JSON payload (reconnect flow).
 * Falls back to null if it's a plain nonce string (existing connect flow).
 */
function decodeStatePayload(
  state: string
): { nonce?: string; reconnectConnectionId?: string } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf-8");
    const obj = JSON.parse(decoded);
    if (typeof obj === "object" && obj !== null)
      return obj as { nonce?: string; reconnectConnectionId?: string };
    return null;
  } catch {
    return null;
  }
}

function errorRedirect(origin: string, error: string) {
  const url = new URL("/settings", origin);
  url.searchParams.set("tab", "integrations");
  url.searchParams.set("error", error);
  return NextResponse.redirect(url.toString(), 302);
}

// Map the provider's ?error to our own fixed vocabulary. NEVER pass the
// provider's error_description through — it is attacker-influenceable and
// would be a reflected-XSS / open-redirect vector (RFC 9700). settings-
// integrations.tsx renders a fixed message per code, never the raw text.
function mapProviderError(providerError: string): string {
  return providerError === "access_denied" ? "consent_declined" : "provider_error";
}

// Idempotent: safe to call on any error path and on a refreshed/replayed
// callback request. A missing pendingId or an already-deleted row is a no-op.
async function deletePendingConnection(pendingId: string | undefined) {
  if (!pendingId) return;
  await db
    .delete(integrationConnections)
    .where(
      and(eq(integrationConnections.id, pendingId), eq(integrationConnections.status, "pending"))
    );
}

// Shared failure path for both exchange steps (token exchange, profile
// fetch) across both providers — the audit shape and cleanup are identical
// regardless of which provider or which step failed; only the reason string
// differs. Kept as one function so the two steps can't drift per provider.
//
// eventType is integration.created — the SAME event as the fresh-connect
// success path a few hundred lines below, differing only by `outcome`.
// Success and failure of the same logical action (mailbox onboarding) must
// share the integration.* family so an auditor filtering
// eventType=integration.created sees both outcomes. config.changed was
// retired for integrations in v0.5.4 (see docs/concepts/audit-trail.mdx and
// docs/guides/upgrading.mdx) — do not reintroduce it here.
async function failOAuthExchange(
  actorId: string,
  providerId: string,
  pendingId: string | undefined,
  reason:
    | "token_exchange_failed"
    | "profile_fetch_failed"
    | "invalid_token_response"
    | "missing_refresh_token"
) {
  deferAuditLog({
    actorType: "user",
    actorId,
    eventType: "integration.created",
    resource: `integration:${providerId}`,
    detail: {
      type: providerId,
      reason,
    },
    outcome: "failure",
  });
  await deletePendingConnection(pendingId);
}

// Thrown internally to unify every "the token response can't be used" failure
// (bad shape, missing access_token, missing refresh_token, or a throwing
// computeExpiresAt) behind ONE catch block below, so every one of them goes
// through failOAuthExchange + errorRedirect instead of surfacing as a raw
// Next.js 500 mid-redirect. Never escapes this module.
class InvalidTokenResponseError extends Error {
  constructor(public readonly reason: "invalid_token_response" | "missing_refresh_token") {
    super(reason);
    this.name = "InvalidTokenResponseError";
  }
}

/**
 * Validate the shape of a provider's token-exchange response before any of
 * its fields are used. A malformed response (missing/wrong-typed
 * access_token, non-numeric expires_in, or — for a flow that requires one —
 * a missing refresh_token) must fail closed with an audited redirect, not a
 * raw throw mid-callback (the single-use authorization code is already
 * burned by this point, so a 500 here strands the user with no way to
 * recover except starting the connect flow over).
 *
 * refresh_token is required unconditionally: both the fresh-connect (GET
 * /oauth/start) and reconnect (POST /oauth/start) authorize URLs always set
 * `prompt=consent` (and Google additionally sets `access_type=offline`), so
 * every token exchange — fresh connect or reconnect — is expected to return
 * a fresh refresh_token from both providers. There is no "preserve the prior
 * refresh_token on reconnect" behavior in this route to preserve: the
 * reconnect branch reads `tokenData.refresh_token` from the SAME exchange,
 * the same way the fresh-connect branch does.
 */
function assertValidTokenResponse<
  T extends { access_token: unknown; refresh_token: unknown; expires_in: unknown },
>(tokenData: T): asserts tokenData is T & { access_token: string; refresh_token: string } {
  if (typeof tokenData.access_token !== "string" || tokenData.access_token.length === 0) {
    throw new InvalidTokenResponseError("invalid_token_response");
  }
  if (typeof tokenData.refresh_token !== "string" || tokenData.refresh_token.length === 0) {
    throw new InvalidTokenResponseError("missing_refresh_token");
  }
}

/**
 * Resolve which provider a callback belongs to when there is no live pending
 * row (fresh-connect flow already exhausted its pending-row lookup, or this
 * is a reconnect which never creates one).
 *
 * For reconnects, the state param carries `reconnectConnectionId`. That
 * connection row's `type` column is the source of truth for which provider
 * this callback is for — it can't drift or get dropped in transit the way a
 * cookie can. Google's reconnect flow relies on this path exclusively (it
 * never sets `oauth_provider`); Microsoft's reconnect flow also sets the
 * cookie as a second signal, but if that cookie is lost this DB lookup is
 * what keeps a Microsoft callback from being exchanged against Google's
 * token endpoint.
 *
 * Falls back to the `oauth_provider` cookie, then to "google" as the
 * last-resort legacy default, matching the pre-existing cascade.
 */
async function resolveProviderFallback(
  reconnectConnectionId: string | undefined,
  providerCookie: string | undefined
): Promise<string> {
  if (reconnectConnectionId) {
    const [reconnectRow] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, reconnectConnectionId))
      .limit(1);
    if (reconnectRow) {
      return reconnectRow.type;
    }
  }
  return providerCookie ?? "google";
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const origin =
    forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : requestUrl.origin;
  const isSecure = (forwardedProto ?? requestUrl.protocol.replace(":", "")) === "https";

  // 1. Validate admin session
  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    return errorRedirect(origin, "unauthorized");
  }

  // 2. Get code, state, and provider-reported error from query params. A
  // request that has neither a code nor a provider error (and/or no state)
  // is simply malformed — fail fast before even looking at cookies.
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const providerError = requestUrl.searchParams.get("error");
  if (!state || (!code && !providerError)) {
    return errorRedirect(origin, "missing_params");
  }

  // 3. CSRF validation: compare state param to oauth_state cookie. This MUST
  // run before we act on providerError — an attacker must not be able to
  // trigger pending-row deletion (or anything else) with a forged state
  // param.
  const cookieHeader = request.headers.get("Cookie") ?? "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return [key, rest.join("=")];
    })
  );
  const cookieState = cookies["oauth_state"];
  if (!cookieState || cookieState !== state) {
    return errorRedirect(origin, "state_mismatch");
  }

  // 3a. Provider reported an error instead of a code (e.g. the user declined
  // consent on Microsoft's/Google's authorize page). This never carries a
  // `code`, so it must be checked before the missing-code guard below.
  // Clean up the abandoned pending row so the UI doesn't show "Setup in
  // progress" until the 15-minute GC in oauth/start eventually reaps it.
  if (providerError) {
    await deletePendingConnection(cookies["oauth_pending_id"]);
    return errorRedirect(origin, mapProviderError(providerError));
  }

  // 3b. No provider error and no code: malformed/incomplete callback request
  // (already ruled out by the combined guard above, but narrows `code` to
  // `string` for TypeScript below).
  if (!code) {
    return errorRedirect(origin, "missing_params");
  }

  // Decode the state once and reuse it for both provider determination below
  // and the reconnect-vs-fresh-connect branch further down.
  const statePayload = decodeStatePayload(state);
  const reconnectConnectionId = statePayload?.reconnectConnectionId;

  // 4. Determine provider. Precedence:
  //    a) reconnect connection row (state carries reconnectConnectionId — this
  //       is authoritative: a reconnect state and a live pending row can only
  //       co-occur when a stale oauth_pending_id cookie survives from an
  //       abandoned fresh-connect flow, so the pending row must NOT be
  //       consulted once we know this is a reconnect. The DB row's `type` is
  //       the source of truth, not the oauth_provider cookie, since Google
  //       reconnect never sets that cookie and any reconnect's cookie can be
  //       dropped in transit)
  //    b) pending connection row (set during oauth/start GET — fresh connect flow)
  //    c) oauth_provider cookie (legacy fallback)
  //    d) "google" (last-resort legacy default)
  const pendingId = cookies["oauth_pending_id"];
  let pendingType: string | undefined;
  if (!reconnectConnectionId && pendingId) {
    const pendingRows = await db
      .select()
      .from(integrationConnections)
      .where(
        and(eq(integrationConnections.id, pendingId), eq(integrationConnections.status, "pending"))
      )
      .limit(1);
    pendingType = pendingRows[0]?.type;
  }
  pendingType ??= await resolveProviderFallback(reconnectConnectionId, cookies["oauth_provider"]);

  // Resolve the descriptor; fail-safe to Google (matches the pendingType
  // default). getOAuthProvider avoids object-injection on pendingType.
  const oauthProvider = getOAuthProvider(pendingType) ?? OAUTH_PROVIDERS.google;

  // 5. Read OAuth settings for the determined provider
  const settings = await getOAuthSettings(oauthProvider.id);
  if (!settings) {
    await deletePendingConnection(pendingId);
    return errorRedirect(origin, "not_configured");
  }

  // 6. Build redirect_uri
  const redirectUri = `${origin}/api/integrations/oauth/callback`;

  let access_token: string;
  let refresh_token: string;
  let expires_in: number;
  let scope: string;
  let emailAddress: string;
  let connection: typeof integrationConnections.$inferSelect;

  // The whole region from token-response parsing through connection
  // persistence is wrapped in one try/catch: a malformed token response
  // (assertValidTokenResponse) or a throwing computeExpiresAt must convert to
  // this route's standard failure handling (audit + errorRedirect) instead of
  // surfacing as a raw 500. By this point the single-use authorization code
  // is already burned, so an uncaught throw would strand the user with no
  // way to recover except restarting the connect flow, and would leave the
  // pending connection row behind for the 15-minute GC to reap.
  try {
    // ── Authorization-code exchange, driven by the provider descriptor ─────
    // Google and Microsoft differ only in DATA, not control flow: whether the
    // token request body includes `scope` (Microsoft) and whether the
    // granted scope used for storage comes from the token response (Google)
    // or the descriptor's own scopes constant (Microsoft). tokenUrl({}) is
    // safe to call unconditionally — Google's implementation ignores
    // tenantId (see oauth-providers.test.ts "ignores tenantId for Google").
    const msSettings = settings as MicrosoftOAuthSettings;
    const tenantId = oauthProvider.hasTenant ? msSettings.tenantId : undefined;

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      redirect_uri: redirectUri,
      ...(oauthProvider.sendScopeInTokenExchange ? { scope: oauthProvider.scopes } : {}),
    });

    const tokenResponse = await fetch(oauthProvider.tokenUrl({ tenantId }), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      await failOAuthExchange(
        session.user.id!,
        oauthProvider.id,
        pendingId,
        "token_exchange_failed"
      );
      return errorRedirect(origin, "token_exchange_failed");
    }

    const tokenData = await tokenResponse.json();
    assertValidTokenResponse(tokenData);
    access_token = tokenData.access_token;
    refresh_token = tokenData.refresh_token;
    expires_in = tokenData.expires_in;
    scope = oauthProvider.scopeFromResponse ? tokenData.scope : oauthProvider.scopes;

    // Fetch the mailbox profile and extract the email address.
    const profileResponse = await fetch(oauthProvider.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!profileResponse.ok) {
      await failOAuthExchange(
        session.user.id!,
        oauthProvider.id,
        pendingId,
        "profile_fetch_failed"
      );
      return errorRedirect(origin, "profile_fetch_failed");
    }

    const profileData = await profileResponse.json();
    emailAddress = oauthProvider.extractEmail(profileData) ?? "";

    // 7. Persist integration — UPDATE pending record if possible, otherwise INSERT
    const expiresAt = computeExpiresAt(expires_in);
    const encryptedCredentials = encrypt(
      JSON.stringify({
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt,
        scope,
      })
    );

    const connectionType = oauthProvider.connectionType;

    const connectionData = {
      emailAddress,
      provider: oauthProvider.auditProvider,
      connectedAt: new Date().toISOString(),
    };

    // Check if this is a reconnect (state encodes reconnectConnectionId,
    // decoded once at the top of the handler and reused here)
    if (reconnectConnectionId) {
      // Reconnect path: update the existing connection row so that
      // agent_connection_permissions referencing it are preserved.
      // Do NOT set status/lastError/lastErrorAt here — let clearIntegrationAuthError
      // handle the auth_failed → active transition and write the integration.auth_recovered
      // audit event. If the connection was already active this is a no-op there.
      [connection] = await db
        .update(integrationConnections)
        .set({
          name: emailAddress,
          credentials: encryptedCredentials,
          data: connectionData,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, reconnectConnectionId))
        .returning();

      if (!connection) {
        return errorRedirect(origin, "connection_not_found");
      }

      // Clear auth_failed state and write integration.auth_recovered audit if needed
      // (no-op if the connection was already active)
      await clearIntegrationAuthError({
        connectionId: reconnectConnectionId,
        actor: { type: "user", id: session.user.id! },
      });

      // 9a. Audit log for reconnect
      // GDPR Art. 17: never record the plaintext email address. The audit row
      // is HMAC-signed, so we cannot redact later. redactEmail() gives us a
      // keyed hash + masked preview; the connectionId in `resource` is enough
      // to look up the live mailbox name from the integrations table while it
      // exists. `name` carries the masked preview (not the raw address) to
      // satisfy the shared `{ id, name }` audit-detail contract for this event
      // type. Mirrors the fresh-connect branch's redaction below.
      const { emailPreview, emailHash } = redactEmail(connection.name);
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "integration.credentials_updated",
        resource: `integration:${connection.id}`,
        detail: {
          id: connection.id,
          name: emailPreview,
          emailHash,
          fields: ["oauth_tokens"],
        },
        outcome: "success",
      });
    } else {
      // Original connect path: UPDATE pending record if possible, otherwise INSERT
      const pendingId = cookies["oauth_pending_id"];

      if (pendingId) {
        const rows = await db
          .select()
          .from(integrationConnections)
          .where(
            and(
              eq(integrationConnections.id, pendingId),
              eq(integrationConnections.status, "pending")
            )
          )
          .limit(1);

        if (rows.length > 0) {
          [connection] = await db
            .update(integrationConnections)
            .set({
              name: emailAddress,
              status: "active",
              credentials: encryptedCredentials,
              data: connectionData,
              updatedAt: new Date(),
            })
            .where(eq(integrationConnections.id, pendingId))
            .returning();
        } else {
          [connection] = await db
            .insert(integrationConnections)
            .values({
              type: connectionType,
              name: emailAddress,
              credentials: encryptedCredentials,
              data: connectionData,
            })
            .returning();
        }
      } else {
        [connection] = await db
          .insert(integrationConnections)
          .values({
            type: connectionType,
            name: emailAddress,
            credentials: encryptedCredentials,
            data: connectionData,
          })
          .returning();
      }
      // 9b. Audit log for new connection
      // GDPR Art. 17: never record the plaintext email address. The audit row
      // is HMAC-signed, so we cannot redact later. redactEmail() gives us a
      // keyed hash + masked preview; the connectionId in `resource` is enough
      // to look up the live mailbox name from the integrations table while it
      // exists. Every provider emits the same `integration.created` event so an
      // auditor filtering by eventType sees every mailbox connection
      // regardless of provider; `type` in detail distinguishes them.
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "integration.created",
        resource: `integration:${connection.id}`,
        detail: {
          type: connectionType,
          ...redactEmail(emailAddress),
        },
        outcome: "success",
      });
    }
  } catch (err) {
    // Catches: assertValidTokenResponse's InvalidTokenResponseError, and any
    // other throw in this region (notably computeExpiresAt, which throws on
    // a missing/non-numeric/negative expires_in). Anything unexpected here
    // must still fail closed with an audited redirect, never a raw 500 — see
    // this file's header comment. The provider id used for the audit/reason
    // is best-effort: oauthProvider.id already reflects the resolved
    // provider for this callback regardless of which branch threw.
    const reason = err instanceof InvalidTokenResponseError ? err.reason : "invalid_token_response";
    await failOAuthExchange(session.user.id!, oauthProvider.id, pendingId, reason);
    return errorRedirect(origin, reason);
  }

  // 9. Clean up cookies and redirect
  const successUrl = new URL("/settings", origin);
  successUrl.searchParams.set("tab", "integrations");
  successUrl.searchParams.set("created", connection.id);

  const response = NextResponse.redirect(successUrl.toString(), 302);
  response.cookies.set("oauth_state", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set("oauth_pending_id", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  response.cookies.set("oauth_provider", "", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
