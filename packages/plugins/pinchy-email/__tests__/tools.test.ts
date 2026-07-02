// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gmail-adapter before importing the plugin
const mockList = vi.fn();
const mockRead = vi.fn();
const mockSearch = vi.fn();
const mockDraft = vi.fn();
const mockSend = vi.fn();
const mockGetAttachment = vi.fn();

vi.mock("../gmail-adapter", () => {
  const MockGmailAdapter = vi.fn(function (this: Record<string, unknown>) {
    this.list = mockList;
    this.read = mockRead;
    this.search = mockSearch;
    this.draft = mockDraft;
    this.send = mockSend;
    this.getAttachment = mockGetAttachment;
  });
  return { GmailAdapter: MockGmailAdapter };
});

vi.mock("../graph-adapter", () => {
  const MockGraphAdapter = vi.fn(function (this: Record<string, unknown>) {
    this.list = mockList;
    this.read = mockRead;
    this.search = mockSearch;
    this.draft = mockDraft;
    this.send = mockSend;
    this.getAttachment = mockGetAttachment;
  });
  return { GraphAdapter: MockGraphAdapter };
});

// Mock node:fs/promises so attachment writes never touch the real filesystem.
// vi.mock(...) is hoisted above these const declarations, so the mock fns
// themselves must be created via vi.hoisted() to avoid a TDZ error.
const { mockMkdir, mockWriteFile, mockAccess } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  access: mockAccess,
}));

import { GmailAdapter } from "../gmail-adapter";
import { GraphAdapter } from "../graph-adapter";
import plugin from "../index";

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<
    string,
    {
      connectionId: string;
      permissions: Record<string, string[]>;
    }
  >;
}

const testConfig: PluginConfig = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-gateway-token",
  agents: {
    "agent-1": {
      connectionId: "conn-1",
      permissions: { email: ["read", "draft"] },
    },
  },
};

function createApi(pluginConfig: PluginConfig = testConfig) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];

  const api = {
    pluginConfig,
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string },
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };

  plugin.register(api);
  return tools;
}

function findTool(
  tools: ReturnType<typeof createApi>,
  name: string,
  agentId?: string,
): AgentTool | null {
  const entry = tools.find((t) => t.name === name);
  if (!entry) return null;
  return entry.factory({ agentId });
}

const agentId = "agent-1";

// Mock global fetch for credential API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockCredentialResponse(accessToken = "test-access-token") {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ type: "google", credentials: { accessToken } }),
  });
}

function mockCredentialFailure(
  status = 500,
  statusText = "Internal Server Error",
) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    statusText,
  });
}

describe("tool registration", () => {
  it("registers all 6 tools", () => {
    const tools = createApi();
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("email_list");
    expect(names).toContain("email_read");
    expect(names).toContain("email_search");
    expect(names).toContain("email_draft");
    expect(names).toContain("email_send");
    expect(names).toContain("email_get_attachment");
  });

  it("returns a non-null stub for all tools when no agentId (OC probe call)", async () => {
    // When OpenClaw calls the factory without session context (e.g. at registerTool()
    // time during hot-reload), returning null would permanently unregister the tool.
    // We return a minimal stub so OC keeps the tool in its registry; the real
    // session-time factory call (with agentId) supersedes it.
    const tools = createApi();
    for (const tool of tools) {
      const stub = tool.factory({});
      expect(stub).not.toBeNull();
      expect(stub!.name).toBe(tool.name);
      // Stub execute() must fail fast rather than call external services
      const result = await stub!.execute("call-probe", {});
      expect(result.isError).toBe(true);
    }
  });

  it("returns null for all tools when agent has no config", () => {
    const tools = createApi();
    for (const tool of tools) {
      expect(tool.factory({ agentId: "unknown-agent" })).toBeNull();
    }
  });

  it("returns tool for agent with matching permission", () => {
    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId);
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("email_list");
  });

  it("returns tool even without specific permission (permission checked at execute time)", () => {
    // Agent has read+draft but not send — tool factory still returns the tool
    // because permission is checked at execution time, not registration time
    const tools = createApi();
    const tool = findTool(tools, "email_send", agentId);
    expect(tool).not.toBeNull();
  });
});

describe("permission checks at execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("email_send returns permission denied when agent lacks send permission", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("email_draft returns permission denied when agent lacks draft permission", async () => {
    const configNoDraft: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: ["read"] },
        },
      },
    };
    const tools = createApi(configNoDraft);
    const tool = findTool(tools, "email_draft", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("credential fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches credentials within TTL — second tool call reuses fetched token", async () => {
    mockCredentialResponse();
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", {});
    await tool.execute("call-2", {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://pinchy:7777/api/internal/integrations/conn-1/credentials",
      { headers: { Authorization: "Bearer test-gateway-token" } },
    );
  });

  it("refetches credentials after the TTL window expires", async () => {
    vi.useFakeTimers();
    try {
      mockCredentialResponse();
      mockList.mockResolvedValue([]);

      const tools = createApi();
      const tool = findTool(tools, "email_list", agentId)!;

      await tool.execute("call-1", {});
      // Advance well past 5min TTL
      vi.advanceTimersByTime(6 * 60 * 1000);
      await tool.execute("call-2", {});

      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates GmailAdapter with fetched access token", async () => {
    mockCredentialResponse("fresh-token-123");
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", {});

    expect(GmailAdapter).toHaveBeenCalledWith({
      accessToken: "fresh-token-123",
    });
  });

  it("dispatches to GmailAdapter when credentials.type is 'google'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "google",
        credentials: { accessToken: "google-token" },
      }),
    });
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", {});

    expect(GmailAdapter).toHaveBeenCalledWith({ accessToken: "google-token" });
  });

  it("dispatches to GraphAdapter when credentials.type is 'microsoft'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "microsoft",
        credentials: { accessToken: "ms-tok" },
      }),
    });
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBeFalsy();
    expect(GraphAdapter).toHaveBeenCalledWith({ accessToken: "ms-tok" });
    expect(GmailAdapter).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("returns error when credential fetch fails", async () => {
    mockCredentialFailure(401, "Unauthorized");

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("credential");
    expect(result.isError).toBe(true);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns error when credential fetch throws network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("ECONNREFUSED");
    expect(result.isError).toBe(true);
  });

  it("throws a clear error when credentials API returns no type field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ credentials: { accessToken: "tok" } }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "credentials API returned no type field",
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  it("REGRESSION (#209): rejects SecretRef-shaped credentials with a clear hint, never reaching Gmail", async () => {
    // The credentials API returns the unresolved SecretRef object instead
    // of decrypted credentials (the bug shape from #209). The plugin must
    // reject this at the boundary instead of forwarding `undefined` as
    // accessToken to Gmail (which would produce a confusing 401).
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "google",
        credentials: {
          source: "file",
          provider: "pinchy",
          id: "/integrations/conn-1/accessToken",
        },
      }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("rejects credentials with missing accessToken", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ type: "google", credentials: {} }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("accessToken");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("invalidates cache and refetches when Gmail returns 401 (rotated/expired token)", async () => {
    // First call: cached token works
    mockCredentialResponse("stale-token");
    mockList.mockResolvedValueOnce([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call: Gmail responds 401 (token expired in the meantime),
    // plugin must invalidate cache, refetch, and retry once with the
    // fresh token from Pinchy.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: "google",
        credentials: { accessToken: "fresh-token" },
      }),
    });
    mockList
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"))
      .mockResolvedValueOnce([]);

    const result = await tool.execute("call-2", {});

    expect(result.isError).toBeFalsy();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // call-1: 1 list call. call-2: 1 list call that rejects with 401, then
    // a retry list call after cache invalidation. Total = 3.
    expect(mockList).toHaveBeenCalledTimes(3);
    // Second GmailAdapter instantiation must use the fresh token
    expect(GmailAdapter).toHaveBeenLastCalledWith({
      accessToken: "fresh-token",
    });
  });

  it("surfaces the auth error if the refetched token also fails", async () => {
    mockCredentialResponse();
    mockList
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"))
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
    // Two credential fetches: initial + refetch after first 401.
    // A third fetch goes to report-auth-failure (best-effort).
    const credentialFetches = mockFetch.mock.calls.filter(
      (c) => !String(c[0]).includes("report-auth-failure"),
    );
    expect(credentialFetches).toHaveLength(2);
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("POSTs report-auth-failure when retry-once also returns an auth error", async () => {
    mockCredentialResponse();
    mockList
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"))
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});

    const reportCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(1);
    const [url, opts] = reportCalls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://pinchy:7777/api/internal/integrations/conn-1/report-auth-failure",
    );
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-gateway-token");
    expect(headers["X-Plugin-Id"]).toBe("pinchy-email");
    const body = JSON.parse(opts.body as string) as { reason: string };
    expect(body.reason).toBeTruthy();
  });

  it("does not POST report-auth-failure on a transient 5xx error", async () => {
    mockCredentialResponse();
    mockList.mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});

    const reportCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(0);
  });
});

describe("email_list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("lists emails with parameters", async () => {
    const emails = [
      {
        id: "msg-1",
        from: "a@test.com",
        subject: "Hello",
        snippet: "Hi there",
      },
    ];
    mockList.mockResolvedValue(emails);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {
      folder: "INBOX",
      limit: 10,
      unreadOnly: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("msg-1");
    expect(mockList).toHaveBeenCalledWith({
      folder: "INBOX",
      limit: 10,
      unreadOnly: true,
    });
  });
});

describe("email_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("reads a single email by id", async () => {
    const email = {
      id: "msg-1",
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe("msg-1");
    expect(data.body).toBe("Full body");
    expect(mockRead).toHaveBeenCalledWith("msg-1");
  });

  it("does not add attachment guidance when the email has no attachments", async () => {
    const email = {
      id: "msg-1",
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
      attachments: [],
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    // Existing behavior preserved: exactly one JSON content block, still parseable.
    expect(result.content).toHaveLength(1);
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe("msg-1");
  });

  it("appends attachment guidance pointing to email_get_attachment when attachments are present", async () => {
    const email = {
      id: "msg-1",
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
      attachments: [
        {
          id: "att-1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 12345,
        },
        {
          id: "att-2",
          filename: "photo.png",
          mimeType: "image/png",
          size: 2048,
        },
      ],
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    // First block remains the untouched JSON payload.
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe("msg-1");
    expect(data.attachments).toHaveLength(2);

    // Guidance is additive — a second block, not a restructure of the first.
    expect(result.content.length).toBeGreaterThan(1);
    const guidance = result.content
      .slice(1)
      .map((b) => b.text)
      .join("\n");
    expect(guidance).toContain("email_get_attachment");
    expect(guidance).toContain("msg-1");
    expect(guidance).toContain("att-1");
    expect(guidance).toContain("invoice.pdf");
    expect(guidance).toContain("application/pdf");
    expect(guidance).toContain("att-2");
    expect(guidance).toContain("photo.png");
  });
});

describe("email_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("searches emails with DSL fields", async () => {
    const emails = [
      {
        id: "msg-2",
        from: "b@test.com",
        subject: "Invoice",
        snippet: "Please pay",
      },
    ];
    mockSearch.mockResolvedValue(emails);

    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", {
      from: "b@test.com",
      subject: "invoice",
      limit: 5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(mockSearch).toHaveBeenCalledWith({
      from: "b@test.com",
      subject: "invoice",
      limit: 5,
    });
  });
});

describe("email_draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("creates a draft email", async () => {
    mockDraft.mockResolvedValue({ draftId: "draft-1" });

    const tools = createApi();
    const tool = findTool(tools, "email_draft", agentId)!;

    const result = await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Draft Subject",
      body: "Draft body text",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.draftId).toBe("draft-1");
    expect(mockDraft).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Draft Subject",
      body: "Draft body text",
      replyTo: undefined,
    });
  });

  it("creates a draft with replyTo", async () => {
    mockDraft.mockResolvedValue({ draftId: "draft-2" });

    const tools = createApi();
    const tool = findTool(tools, "email_draft", agentId)!;

    await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "msg-1",
    });

    expect(mockDraft).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "msg-1",
    });
  });
});

describe("email_send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("sends an email when agent has send permission", async () => {
    mockSend.mockResolvedValue({ messageId: "sent-1" });

    const configWithSend: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: ["read", "draft", "send"] },
        },
      },
    };
    const tools = createApi(configWithSend);
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Sent Subject",
      body: "Sent body text",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.messageId).toBe("sent-1");
    expect(mockSend).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Sent Subject",
      body: "Sent body text",
      replyTo: undefined,
    });
  });

  it("reports a direct send honestly when the adapter returns messageId: null (Graph's 202-with-no-location case) instead of fabricating an empty id", async () => {
    mockSend.mockResolvedValue({ messageId: null });

    const configWithSend: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: ["read", "draft", "send"] },
        },
      },
    };
    const tools = createApi(configWithSend);
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Sent Subject",
      body: "Sent body text",
    });

    const data = JSON.parse(result.content[0].text);
    // The result must not silently claim a fabricated "" id — either the
    // field is absent/null, or the surrounding text makes clear no id is
    // available. It must NOT be an empty string standing in as a fake id.
    expect(data.messageId).not.toBe("");
    expect(data.messageId).toBeNull();
    const allText = result.content.map((c) => c.text).join("\n");
    expect(allText).toMatch(/sent/i);
  });
});

describe("error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("returns error message when Gmail adapter throws", async () => {
    mockList.mockRejectedValue(new Error("Gmail API rate limit exceeded"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("Gmail API rate limit exceeded");
    expect(result.isError).toBe(true);
  });

  it("handles non-Error throws gracefully", async () => {
    mockList.mockRejectedValue("string error");

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("Unknown error");
    expect(result.isError).toBe(true);
  });
});

describe("email_get_attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
    // Default: no filename collision (target path does not exist yet).
    mockAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("is gated on email.read permission and never touches the filesystem when denied", async () => {
    const configNoRead: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: [] },
        },
      },
    };
    const tools = createApi(configNoRead);
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetAttachment).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("downloads the attachment and writes it to the agent's uploads directory", async () => {
    const data = Buffer.from("pdf-bytes-here");
    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data,
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAttachment).toHaveBeenCalledWith("msg-1", "att-1");
    expect(mockMkdir).toHaveBeenCalledWith(
      "/root/.openclaw/workspaces/agent-1/uploads",
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf",
      data,
      { flag: "wx" },
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toBe("invoice.pdf");
    expect(payload.size).toBe(data.length);
    expect(payload.mimeType).toBe("application/pdf");

    // Guidance references the hand-off to odoo_attach_file and the written name.
    const guidance = result.content
      .slice(1)
      .map((b) => b.text)
      .join("\n");
    expect(guidance).toContain("odoo_attach_file");
    expect(guidance).toContain("invoice.pdf");
  });

  it("never includes attachment content/bytes in the tool result", async () => {
    const data = Buffer.from("super-secret-binary-content");
    mockGetAttachment.mockResolvedValue({
      filename: "secret.bin",
      mimeType: "application/octet-stream",
      data,
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    const fullText = result.content.map((b) => b.text).join("\n");
    expect(fullText).not.toContain("super-secret-binary-content");
    expect(fullText).not.toContain(data.toString("base64"));
  });

  it("sanitizes a path-traversal filename (POSIX) so the write stays inside uploads/", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "../../etc/passwd",
      mimeType: "text/plain",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    const [writtenPath] = mockWriteFile.mock.calls[0] as [string, Buffer];
    expect(
      writtenPath.startsWith("/root/.openclaw/workspaces/agent-1/uploads/"),
    ).toBe(true);
    expect(writtenPath).not.toContain("..");
    expect(writtenPath).not.toContain("/etc/passwd");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).not.toContain("/");
    expect(payload.filename).not.toContain("\\");
    expect(payload.filename).not.toContain("..");
  });

  it("sanitizes a path-traversal filename (Windows-style backslashes)", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "..\\..\\evil.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    const [writtenPath] = mockWriteFile.mock.calls[0] as [string, Buffer];
    expect(
      writtenPath.startsWith("/root/.openclaw/workspaces/agent-1/uploads/"),
    ).toBe(true);
    expect(writtenPath).not.toContain("\\");
    expect(writtenPath).not.toContain("..");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).not.toContain("\\");
    expect(payload.filename).not.toContain("..");
  });

  it("falls back to a generated name for an empty filename, using the mime type for the extension", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-12345",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toMatch(/^attachment-.+\.pdf$/);
  });

  it("falls back to a .bin extension for an unrecognized mime type with an empty filename", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "   ",
      mimeType: "application/x-mystery",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-99999",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toMatch(/^attachment-.+\.bin$/);
  });

  it("appends a numeric suffix on filename collision instead of overwriting", async () => {
    // First access() check (invoice.pdf) resolves => file exists => collision.
    // Second access() check (invoice-1.pdf) rejects ENOENT => free name.
    mockAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toBe("invoice-1.pdf");
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/root/.openclaw/workspaces/agent-1/uploads/invoice-1.pdf",
      expect.anything(),
      { flag: "wx" },
    );
    // Never overwrite: writeFile must only ever be called with the free name,
    // and the exclusive "wx" flag makes that guarantee atomic.
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("keeps incrementing the suffix until a free name is found", async () => {
    mockAccess
      .mockResolvedValueOnce(undefined) // invoice.pdf exists
      .mockResolvedValueOnce(undefined) // invoice-1.pdf exists
      .mockResolvedValueOnce(undefined) // invoice-2.pdf exists
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      ); // invoice-3.pdf free
    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toBe("invoice-3.pdf");
  });

  it("rejects an attachment whose downloaded byte length exceeds the 25 MB cap", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    mockGetAttachment.mockResolvedValue({
      filename: "big.pdf",
      mimeType: "application/pdf",
      data: oversized,
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("25 MB");
    expect(mockWriteFile).not.toHaveBeenCalled();
    // No content/bytes leaked in the error path either.
    const fullText = result.content.map((b) => b.text).join("\n");
    expect(fullText).not.toContain(oversized.toString("base64").slice(0, 50));
  });

  it("requires messageId and attachmentId parameters", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;
    expect(tool.parameters).toMatchObject({
      required: expect.arrayContaining(["messageId", "attachmentId"]),
    });
  });

  it("propagates adapter errors via errorResult", async () => {
    mockGetAttachment.mockRejectedValue(new Error("attachment not found"));

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("attachment not found");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
