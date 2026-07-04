import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import {
  getOAuthSettings,
  saveOAuthSettings,
  deleteOAuthSettings,
} from "@/lib/integrations/oauth-settings";
import { getOAuthProvider } from "@/lib/integrations/oauth-providers";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { saveOAuthSchema } from "@/lib/schemas/oauth-settings";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { and, count, eq, ne } from "drizzle-orm";

const SUPPORTED_PROVIDERS = ["google", "microsoft"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && SUPPORTED_PROVIDERS.includes(value as SupportedProvider);
}

/**
 * Count the mailbox connections that depend on a provider's OAuth app. Used to
 * warn the admin how many connections will need to reconnect before they edit
 * or reset the app credentials. `connectionType` equals the id but is read from
 * the descriptor so the type value stays a single source of truth.
 */
async function countProviderConnections(provider: SupportedProvider): Promise<number> {
  const connectionType = getOAuthProvider(provider)!.connectionType;
  const rows = await db
    .select({ value: count() })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.type, connectionType),
        // Exclude half-finished OAuth flows: a "pending" row is created by
        // /oauth/start and only cleaned up on the *next* /oauth/start, so an
        // abandoned attempt would otherwise inflate the Reset/Disconnect
        // dialog's "will disconnect N connected integration(s)" warning with
        // a connection that was never actually live (mirrors the reasoning
        // in settings-integrations.tsx).
        ne(integrationConnections.status, "pending")
      )
    );
  return rows[0]?.value ?? 0;
}

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "Invalid or missing provider" }, { status: 400 });
  }

  const connectionCount = await countProviderConnections(provider);
  const oauthProvider = getOAuthProvider(provider)!;

  const settings = await getOAuthSettings(provider);
  if (!settings) {
    return NextResponse.json({ configured: false, clientId: "", connectionCount });
  }

  // Tenant-scoped providers (Microsoft) also surface the stored tenantId so
  // the edit dialog can prefill it. The client secret is never returned.
  return NextResponse.json({
    configured: true,
    clientId: settings.clientId,
    connectionCount,
    ...(oauthProvider.hasTenant
      ? { tenantId: (settings as { tenantId?: string }).tenantId ?? "" }
      : {}),
  });
}

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const parsed = await parseRequestBody(saveOAuthSchema, request);
  if ("error" in parsed) return parsed.error;
  const data = parsed.data;
  // getOAuthProvider is non-null: the schema restricts provider to google/microsoft.
  const oauthProvider = getOAuthProvider(data.provider)!;

  // An omitted clientSecret means "keep the current one" so an admin can
  // update the Client ID (and, for Microsoft, the Tenant ID) without
  // re-entering the secret. Fall back to the stored secret when omitted; if
  // there's nothing stored yet, this is first-time setup (this same endpoint
  // also backs the Add-Integration wizard) and a secret is required.
  let clientSecret = data.clientSecret;
  if (!clientSecret) {
    const existing = await getOAuthSettings(data.provider);
    if (!existing) {
      return NextResponse.json(
        { error: "Client Secret is required when configuring a new app." },
        { status: 400 }
      );
    }
    clientSecret = existing.clientSecret;
  }

  // Pre-flight provider-specific config check (e.g. Microsoft's tenant id):
  // delegated to the descriptor so provider-specific validation lives in
  // oauth-providers.ts alongside extractEmail/authorizeUrl, instead of a
  // hardcoded `provider === "microsoft"` branch here. Undefined method or
  // { ok: true } allows the save through unchanged. Only invoked when a
  // tenantId is actually present, so providers without one (and a blank
  // Microsoft tenantId, which just falls back to "organizations") skip the
  // check without going through validateConfig at all.
  const tenantId = "tenantId" in data ? data.tenantId : undefined;
  if (tenantId) {
    const validation = await oauthProvider.validateConfig?.({ tenantId });
    if (validation && !validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  // Persist per-provider settings (Microsoft carries an optional tenantId). The
  // save stays branch-narrowed so saveOAuthSettings' generic gets the exact
  // ProviderSettings[P] shape it expects; the audit write below is shared.
  if (data.provider === "microsoft") {
    const { clientId, tenantId } = data;
    await saveOAuthSettings(
      "microsoft",
      tenantId ? { clientId, clientSecret, tenantId } : { clientId, clientSecret }
    );
  } else {
    const { clientId } = data;
    await saveOAuthSettings("google", { clientId, clientSecret });
  }

  const provider = data.provider;
  // settingsKey is the same value as the audit rows recorded before this
  // refactor (google_oauth_credentials / microsoft_oauth_credentials).
  const settingsKey = oauthProvider.settingsKey;
  // Saving OAuth app settings is idempotent, so an audit-write failure is
  // allowed to surface as a 500 rather than being dropped fire-and-forget —
  // the admin can safely retry the same save.
  await appendAuditLog({
    actorType: "user",
    actorId: sessionOrError.user.id!,
    resource: `integration:${provider}-oauth`,
    eventType: "config.changed",
    detail: { key: settingsKey, provider },
    outcome: "success",
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "Invalid or missing provider" }, { status: 400 });
  }

  // Reset the provider's OAuth app credentials. Existing mailbox connections
  // are left untouched but will need to be reconnected once a new app is set.
  await deleteOAuthSettings(provider);

  // Idempotent, same reasoning as POST above: let an audit-write failure
  // surface as a 500 instead of dropping it fire-and-forget.
  await appendAuditLog({
    actorType: "user",
    actorId: sessionOrError.user.id!,
    resource: `integration:${provider}-oauth`,
    eventType: "config.changed",
    detail: { action: "oauth_app_reset", provider },
    outcome: "success",
  });

  return NextResponse.json({ success: true });
}
