import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { GraphAdapter } from "../graph-adapter.js";

describe("GraphAdapter.list", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GRAPH_API_BASE_URL;
  });

  it("list({folder:'INBOX'}) hits /v1.0/me/mailFolders/inbox/messages", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.list({ folder: "INBOX", limit: 5 });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/me/mailFolders/inbox/messages"),
      expect.any(Object),
    );
  });

  it("list({}) hits /v1.0/me/messages with no folder filter", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.list({});
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/me/messages"),
      expect.any(Object),
    );
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("mailFolders"),
      expect.any(Object),
    );
  });

  it("list({unreadOnly:true}) appends $filter=isRead eq false", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.list({ unreadOnly: true });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("$filter=isRead%20eq%20false"),
      expect.any(Object),
    );
  });

  it("unknown folder throws", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    await expect(adapter.list({ folder: "CUSTOM" as never })).rejects.toThrow(
      /unknown folder/i,
    );
  });

  it("uses GRAPH_API_BASE_URL when set", async () => {
    process.env.GRAPH_API_BASE_URL = "http://graph-mock:9005";
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.list({});
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("http://graph-mock:9005/v1.0/me/messages"),
      expect.any(Object),
    );
    delete process.env.GRAPH_API_BASE_URL;
  });
});

describe("GraphAdapter.read", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("read(id) hits /v1.0/me/messages/<id>", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "msg1",
        subject: "Hello",
        bodyPreview: "Hi there",
        receivedDateTime: "2024-01-01T10:00:00Z",
        from: { emailAddress: { address: "alice@example.com" } },
        toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
        ccRecipients: [{ emailAddress: { address: "charlie@example.com" } }],
        isRead: false,
        body: { contentType: "text", content: "Hi there, full body" },
      }),
    });
    const result = await adapter.read("msg1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1.0/me/messages/msg1"),
      expect.any(Object),
    );
    expect(result.body).toBe("Hi there, full body");
    expect(result.cc).toBe("charlie@example.com");
    expect(result.unread).toBe(true);
  });

  it("non-ok response throws a descriptive error", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Message not found",
    });
    await expect(adapter.read("msg1")).rejects.toThrow(/Graph 404/);
  });

  it("URL-encodes the message ID in the path", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "msg/special+id",
        subject: "S",
        bodyPreview: "",
        receivedDateTime: "2024-01-01T10:00:00Z",
        from: { emailAddress: { address: "a@b.com" } },
        toRecipients: [],
        isRead: true,
        body: { contentType: "text", content: "" },
      }),
    });
    await adapter.read("msg/special+id");
    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("msg/special+id"));
    expect(url).not.toContain("/msg/special+id");
  });
});

describe("GraphAdapter.read attachments", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  function messageResponse(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      json: async () => ({
        id: "msg1",
        subject: "Invoice",
        bodyPreview: "See attached",
        receivedDateTime: "2024-01-01T10:00:00Z",
        from: { emailAddress: { address: "billing@example.com" } },
        toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
        ccRecipients: [],
        isRead: true,
        body: { contentType: "text", content: "See attached" },
        ...overrides,
      }),
    };
  }

  it("requests hasAttachments in the read $select", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce(
      messageResponse({ hasAttachments: false }),
    );
    await adapter.read("msg1");
    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(decodeURIComponent(url)).toContain("hasAttachments");
  });

  it("does NOT make a second request when hasAttachments is false", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce(
      messageResponse({ hasAttachments: false }),
    );
    const result = await adapter.read("msg1");
    expect(result.attachments).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/attachments"),
      expect.any(Object),
    );
  });

  it("fetches /attachments and maps fileAttachments when hasAttachments is true", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce(messageResponse({ hasAttachments: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "att-1",
              name: "invoice.pdf",
              contentType: "application/pdf",
              size: 12345,
              isInline: false,
            },
          ],
        }),
      });

    const result = await adapter.read("msg1");

    expect(result.attachments).toEqual([
      {
        id: "att-1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 12345,
      },
    ]);
    const secondUrl = (fetch as Mock).mock.calls[1][0] as string;
    expect(secondUrl).toContain("/v1.0/me/messages/msg1/attachments");
  });

  it("filters out inline attachments", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce(messageResponse({ hasAttachments: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "att-inline",
              name: "logo.png",
              contentType: "image/png",
              size: 200,
              isInline: true,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "att-real",
              name: "invoice.pdf",
              contentType: "application/pdf",
              size: 9000,
              isInline: false,
            },
          ],
        }),
      });

    const result = await adapter.read("msg1");

    expect(result.attachments).toEqual([
      {
        id: "att-real",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 9000,
      },
    ]);
  });

  it("filters out non-file attachment types (itemAttachment / referenceAttachment)", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce(messageResponse({ hasAttachments: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              "@odata.type": "#microsoft.graph.itemAttachment",
              id: "att-item",
              name: "Forwarded message",
              contentType: null,
              size: 5000,
              isInline: false,
            },
            {
              "@odata.type": "#microsoft.graph.referenceAttachment",
              id: "att-ref",
              name: "shared.docx",
              contentType: null,
              size: 0,
              isInline: false,
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: "att-file",
              name: "invoice.pdf",
              contentType: "application/pdf",
              size: 9000,
              isInline: false,
            },
          ],
        }),
      });

    const result = await adapter.read("msg1");

    expect(result.attachments).toEqual([
      {
        id: "att-file",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 9000,
      },
    ]);
  });
});

describe("GraphAdapter.getAttachment", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("downloads a fileAttachment and reconstructs its raw bytes", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    // Include high-bit bytes that encode to '+' and '/' in standard base64
    // (e.g. 0xFB 0xFF 0xBF → "+/+/…") so the assertion exercises the full byte
    // range through the decode, not just printable ASCII. (This does not pin
    // base64-vs-base64url specifically — Node's Buffer decoder accepts both
    // alphabets interchangeably; the adapter's choice of "base64" is a
    // correctness-of-intent signal.)
    const bytes = Buffer.concat([
      Buffer.from("%PDF-1.7"),
      Buffer.from([0xfb, 0xff, 0xbf]),
    ]);
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "att-1",
        name: "invoice.pdf",
        contentType: "application/pdf",
        size: bytes.length,
        isInline: false,
        contentBytes: bytes.toString("base64"),
      }),
    });

    const result = await adapter.getAttachment("msg1", "att-1");

    expect(result.filename).toBe("invoice.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(Buffer.isBuffer(result.data)).toBe(true);
    expect(result.data.equals(bytes)).toBe(true);

    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(url).toContain("/v1.0/me/messages/msg1/attachments/att-1");
  });

  it("URL-encodes message and attachment ids in the path", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "f.bin",
        contentType: "application/octet-stream",
        contentBytes: Buffer.from("x").toString("base64"),
      }),
    });

    await adapter.getAttachment("msg/a+b", "att/c+d");

    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("msg/a+b"));
    expect(url).toContain(encodeURIComponent("att/c+d"));
  });

  it("throws for an itemAttachment that has no downloadable contentBytes", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        "@odata.type": "#microsoft.graph.itemAttachment",
        id: "att-item",
        name: "Forwarded message",
        contentType: null,
        size: 5000,
        isInline: false,
        // no contentBytes
      }),
    });

    await expect(adapter.getAttachment("msg1", "att-item")).rejects.toThrow(
      /embedded item/i,
    );
  });

  it("propagates a Graph error response", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "attachment not found",
    });
    await expect(adapter.getAttachment("msg1", "gone")).rejects.toThrow(
      /Graph 404/,
    );
  });
});

describe("GraphAdapter.search", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("search({from,subject}) issues $search with from: and subject:", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.search({ from: "alice@example.com", subject: "invoice" });
    const url = (fetch as Mock).mock.calls[0][0] as string;
    expect(url).toContain("%24search=");
    expect(decodeURIComponent(url)).toContain("from:alice@example.com");
    expect(decodeURIComponent(url)).toContain("subject:invoice");
  });

  it("search({unread:true,sinceDays:7}) uses $filter for date and isRead", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.search({ unread: true, sinceDays: 7 });
    const url = (fetch as Mock).mock.calls[0][0] as string;
    // URLSearchParams encodes spaces as +; decode both %xx and + before asserting
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).toContain("isRead eq false");
    expect(decoded).toContain("receivedDateTime ge");
  });

  it("search({}) throws 'at least one filter'", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    await expect(adapter.search({})).rejects.toThrow(/at least one/i);
  });

  it("search({from, unread}) uses only $filter (not $search) when both present", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.search({ from: "alice@example.com", unread: true });
    const url = (fetch as Mock).mock.calls[0][0] as string;
    // URLSearchParams encodes spaces as +; decode both %xx and + before asserting
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).not.toContain("$search");
    expect(decoded).toContain(
      "from/emailAddress/address eq 'alice@example.com'",
    );
    expect(decoded).toContain("isRead eq false");
  });

  it("escapes single quotes in $filter values (OData injection guard)", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    // unread forces the $filter path; the apostrophe must be doubled so it
    // can't terminate the OData string literal early.
    await adapter.search({ from: "o'brien@example.com", unread: true });
    const url = (fetch as Mock).mock.calls[0][0] as string;
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).toContain(
      "from/emailAddress/address eq 'o''brien@example.com'",
    );
  });

  it("folder scopes via mailFolders path", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    });
    await adapter.search({ from: "alice@example.com", folder: "SENT" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/mailFolders/sentitems/messages"),
      expect.any(Object),
    );
  });
});

describe("GraphAdapter.draft", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("draft({to,subject,body}) POSTs to /me/messages and returns draftId", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "draft1" }),
    });
    const result = await adapter.draft({
      to: "bob@example.com",
      subject: "Test",
      body: "Hello",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/messages"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.draftId).toBe("draft1");
  });

  it("draft({...,replyTo}) uses createReply endpoint", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "reply1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const result = await adapter.draft({
      to: "bob@example.com",
      subject: "Re: Test",
      body: "Thanks",
      replyTo: "original-msg-id",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/messages/original-msg-id/createReply"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.draftId).toBe("reply1");
  });

  it("new draft body contains subject, body.contentType, body.content, and toRecipients", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "draft1" }),
    });
    await adapter.draft({
      to: "bob@example.com",
      subject: "Test Subject",
      body: "Hello body",
    });
    const call = (fetch as Mock).mock.calls[0];
    const sentBody = JSON.parse((call[1] as RequestInit).body as string);
    expect(sentBody.subject).toBe("Test Subject");
    expect(sentBody.body.contentType).toBe("text");
    expect(sentBody.body.content).toBe("Hello body");
    expect(sentBody.toRecipients).toEqual([
      { emailAddress: { address: "bob@example.com" } },
    ]);
  });
});

describe("GraphAdapter.send", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("send({to,subject,body}) POSTs to /me/sendMail", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({}),
    });
    await adapter.send({
      to: "bob@example.com",
      subject: "Test",
      body: "Hello",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/sendMail"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("send({to,subject,body}) returns messageId: null — Graph's /sendMail answers 202 with no location header, so there is no real id to report", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock).mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      json: async () => ({}),
    });
    const result = await adapter.send({
      to: "bob@example.com",
      subject: "Test",
      body: "Hello",
    });
    expect(result).toEqual({ messageId: null });
  });

  it("send({...,replyTo}) creates draft + sends it", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "reply1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({}),
      });
    await adapter.send({
      to: "bob@example.com",
      subject: "Re: Test",
      body: "Thanks",
      replyTo: "original-id",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/me/messages/reply1/send"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("send({...,replyTo}) returns draftId as messageId", async () => {
    const adapter = new GraphAdapter({ accessToken: "tok" });
    (fetch as Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "reply42" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => null },
        json: async () => ({}),
      });
    const result = await adapter.send({
      to: "bob@example.com",
      subject: "Re: Test",
      body: "Thanks",
      replyTo: "original-id",
    });
    expect(result.messageId).toBe("reply42");
  });
});
