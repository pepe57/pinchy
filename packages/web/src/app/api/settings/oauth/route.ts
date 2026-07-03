import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import {
  getOAuthSettings,
  saveOAuthSettings,
  deleteOAuthSettings,
} from "@/lib/integrations/oauth-settings";
import { getOAuthProvider } from "@/lib/integrations/oauth-providers";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { count, eq } from "drizzle-orm";

const SUPPORTED_PROVIDERS = ["google", "microsoft"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && SUPPORTED_PROVIDERS.includes(value as SupportedProvider);
}

const saveGoogleOAuthSchema = z.object({
  provider: z.literal("google"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

const saveMicrosoftOAuthSchema = z.object({
  provider: z.literal("microsoft"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
});

const saveOAuthSchema = z.discriminatedUnion("provider", [
  saveGoogleOAuthSchema,
  saveMicrosoftOAuthSchema,
]);

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
    .where(eq(integrationConnections.type, connectionType));
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

  // Tenant-scoped providers (Microsoft) also surface the stored tenantId so
  // the edit dialog can prefill it. The client secret is never returned.
  if (provider === "microsoft") {
    const settings = await getOAuthSettings("microsoft");
    if (!settings) {
      return NextResponse.json({ configured: false, clientId: "", connectionCount });
    }
    return NextResponse.json({
      configured: true,
      clientId: settings.clientId,
      tenantId: settings.tenantId ?? "",
      connectionCount,
    });
  }

  const settings = await getOAuthSettings(provider);
  if (!settings) {
    return NextResponse.json({ configured: false, clientId: "", connectionCount });
  }

  return NextResponse.json({
    configured: true,
    clientId: settings.clientId,
    connectionCount,
  });
}

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const parsed = await parseRequestBody(saveOAuthSchema, request);
  if ("error" in parsed) return parsed.error;
  const data = parsed.data;

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
  // getOAuthProvider is non-null for the discriminated-union providers; its
  // settingsKey is the same value as the audit rows recorded before this
  // refactor (google_oauth_credentials / microsoft_oauth_credentials).
  const settingsKey = getOAuthProvider(provider)!.settingsKey;
  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: sessionOrError.user.id!,
      resource: `integration:${provider}-oauth`,
      eventType: "config.changed",
      detail: { key: settingsKey, provider },
      outcome: "success",
    })
  );

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

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: sessionOrError.user.id!,
      resource: `integration:${provider}-oauth`,
      eventType: "config.changed",
      detail: { action: "oauth_app_reset", provider },
      outcome: "success",
    })
  );

  return NextResponse.json({ success: true });
}
