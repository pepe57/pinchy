// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock googleapis before importing the adapter
const mockList = vi.fn();
const mockGet = vi.fn();
const mockDraftsCreate = vi.fn();
const mockSend = vi.fn();
const mockAttachmentsGet = vi.fn();

// Mock googleapis. `google.auth.OAuth2` is invoked with `new` in
// gmail-adapter.ts, so the mock must expose a real (constructable) class,
// not an arrow-function factory — vitest 4 (unlike vitest 3) only treats
// the latter as callable, not constructable. The class is defined inside the
// factory because `vi.mock` is hoisted to the top of the file.
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials = vi.fn();
  }
  return {
    google: {
      gmail: vi.fn(() => ({
        users: {
          messages: {
            list: mockList,
            get: mockGet,
            send: mockSend,
            attachments: {
              get: mockAttachmentsGet,
            },
          },
          drafts: {
            create: mockDraftsCreate,
          },
        },
      })),
      auth: {
        OAuth2: MockOAuth2,
      },
    },
  };
});

import { GmailAdapter } from "../gmail-adapter.js";

// Helper: base64url encode a string
function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

describe("GmailAdapter", () => {
  let adapter: GmailAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GmailAdapter({ accessToken: "test-token" });
  });

  describe("list", () => {
    it("returns email summaries from Gmail API", async () => {
      mockList.mockResolvedValue({
        data: {
          messages: [{ id: "msg1" }, { id: "msg2" }],
        },
      });

      mockGet
        .mockResolvedValueOnce({
          data: {
            id: "msg1",
            snippet: "Hello there",
            labelIds: ["UNREAD", "INBOX"],
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Test email" },
                { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
              ],
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: "msg2",
            snippet: "Another one",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "charlie@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Second email" },
                { name: "Date", value: "Mon, 7 Apr 2026 11:00:00 +0000" },
              ],
            },
          },
        });

      const result = await adapter.list({ limit: 10 });

      expect(result).toEqual([
        {
          id: "msg1",
          from: "alice@example.com",
          to: "bob@example.com",
          subject: "Test email",
          date: "Mon, 7 Apr 2026 10:00:00 +0000",
          snippet: "Hello there",
          unread: true,
        },
        {
          id: "msg2",
          from: "charlie@example.com",
          to: "bob@example.com",
          subject: "Second email",
          date: "Mon, 7 Apr 2026 11:00:00 +0000",
          snippet: "Another one",
          unread: false,
        },
      ]);

      expect(mockList).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 10,
        q: undefined,
        labelIds: undefined,
      });

      expect(mockGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
    });

    it("filters by folder using labelIds", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.list({ folder: "INBOX" });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ["INBOX"] }),
      );
    });

    it("filters unread only", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.list({ unreadOnly: true });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ q: "is:unread" }),
      );
    });

    it("returns empty array when no messages", async () => {
      mockList.mockResolvedValue({ data: {} });

      const result = await adapter.list({});

      expect(result).toEqual([]);
    });

    it("defaults limit to 20", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.list({});

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 20 }),
      );
    });
  });

  describe("read", () => {
    it("returns full email with plain text body from single-part message", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg1",
          snippet: "Hello there",
          labelIds: ["UNREAD", "INBOX"],
          payload: {
            mimeType: "text/plain",
            body: { data: base64url("Hello, this is the body.") },
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Cc", value: "charlie@example.com" },
              { name: "Subject", value: "Test email" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg1");

      expect(result).toEqual({
        id: "msg1",
        from: "alice@example.com",
        to: "bob@example.com",
        cc: "charlie@example.com",
        subject: "Test email",
        date: "Mon, 7 Apr 2026 10:00:00 +0000",
        snippet: "Hello there",
        unread: true,
        body: "Hello, this is the body.",
        attachments: [],
      });

      expect(mockGet).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        format: "full",
      });
    });

    it("extracts text/plain from multipart message", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg2",
          snippet: "Multi",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: base64url("Plain text body") },
              },
              {
                mimeType: "text/html",
                body: { data: base64url("<b>HTML body</b>") },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "Multipart" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg2");

      expect(result.body).toBe("Plain text body");
    });

    it("falls back to text/html when no text/plain", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg3",
          snippet: "HTML only",
          labelIds: [],
          payload: {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/html",
                body: { data: base64url("<b>HTML only</b>") },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "HTML only" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg3");

      expect(result.body).toBe("<b>HTML only</b>");
    });

    it("handles nested multipart/mixed with multipart/alternative", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg4",
          snippet: "Nested",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "multipart/alternative",
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: base64url("Nested plain") },
                  },
                  {
                    mimeType: "text/html",
                    body: { data: base64url("<b>Nested HTML</b>") },
                  },
                ],
              },
              {
                mimeType: "application/pdf",
                filename: "doc.pdf",
                body: { attachmentId: "att1" },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "Nested" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg4");

      expect(result.body).toBe("Nested plain");
    });

    it("returns empty body when no text parts found", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg5",
          snippet: "No body",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "application/pdf",
                filename: "doc.pdf",
                body: { attachmentId: "att1" },
              },
            ],
            headers: [
              { name: "From", value: "alice@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "No body" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg5");

      expect(result.body).toBe("");
    });
  });

  describe("read attachments", () => {
    it("lists attachment metadata from parts with a filename and attachmentId", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg-att",
          snippet: "Invoice",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: base64url("See attached invoice") },
              },
              {
                mimeType: "application/pdf",
                filename: "invoice.pdf",
                body: { attachmentId: "att-abc", size: 12345 },
              },
            ],
            headers: [
              { name: "From", value: "billing@example.com" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "Invoice" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-att");

      expect(result.attachments).toEqual([
        {
          id: "att-abc",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 12345,
        },
      ]);
      expect(result.body).toBe("See attached invoice");
    });

    it("collects attachments from deeply nested multipart parts", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg-nested-att",
          snippet: "Nested",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "multipart/alternative",
                parts: [
                  { mimeType: "text/plain", body: { data: base64url("body") } },
                ],
              },
              {
                mimeType: "multipart/mixed",
                parts: [
                  {
                    mimeType: "application/pdf",
                    filename: "deep.pdf",
                    body: { attachmentId: "att-deep", size: 42 },
                  },
                ],
              },
            ],
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "Nested" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-nested-att");

      expect(result.attachments).toEqual([
        {
          id: "att-deep",
          filename: "deep.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      ]);
    });

    it("skips inline parts that have an attachmentId but no filename", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg-inline",
          snippet: "Inline image",
          labelIds: [],
          payload: {
            mimeType: "multipart/related",
            parts: [
              {
                mimeType: "text/html",
                body: { data: base64url("<img src=cid:x>") },
              },
              {
                // Inline image: attachmentId present, but no filename → not a
                // user-facing attachment.
                mimeType: "image/png",
                filename: "",
                body: { attachmentId: "att-inline", size: 999 },
              },
            ],
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "Inline" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-inline");

      expect(result.attachments).toEqual([]);
    });

    it("returns an empty attachments array for a plain single-part message", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg-plain",
          snippet: "Plain",
          labelIds: [],
          payload: {
            mimeType: "text/plain",
            body: { data: base64url("just text") },
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "Plain" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-plain");

      expect(result.attachments).toEqual([]);
    });

    it("defaults size to 0 when the part body omits it", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg-nosize",
          snippet: "No size",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "application/octet-stream",
                filename: "data.bin",
                body: { attachmentId: "att-nosize" },
              },
            ],
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "No size" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-nosize");

      expect(result.attachments).toEqual([
        {
          id: "att-nosize",
          filename: "data.bin",
          mimeType: "application/octet-stream",
          size: 0,
        },
      ]);
    });
  });

  describe("getAttachment", () => {
    it("downloads bytes and resolves filename/mimeType by re-reading the message", async () => {
      // getAttachment first re-fetches the message to recover filename/mimeType
      // (the attachments.get endpoint returns only {size, data}), then fetches
      // the bytes.
      mockGet.mockResolvedValue({
        data: {
          id: "msg-dl",
          snippet: "Invoice",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              { mimeType: "text/plain", body: { data: base64url("body") } },
              {
                mimeType: "application/pdf",
                filename: "invoice.pdf",
                body: { attachmentId: "att-dl", size: 5 },
              },
            ],
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "Invoice" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });
      mockAttachmentsGet.mockResolvedValue({
        data: { size: 5, data: Buffer.from("%PDF-").toString("base64url") },
      });

      const result = await adapter.getAttachment("msg-dl", "att-dl");

      expect(result.filename).toBe("invoice.pdf");
      expect(result.mimeType).toBe("application/pdf");
      expect(Buffer.isBuffer(result.data)).toBe(true);
      expect(result.data.toString("utf-8")).toBe("%PDF-");

      expect(mockAttachmentsGet).toHaveBeenCalledWith({
        userId: "me",
        messageId: "msg-dl",
        id: "att-dl",
      });
    });

    it("decodes base64url (URL-safe alphabet), not standard base64", async () => {
      // Bytes 0xFB 0xFF 0xBF encode to "-_-_" in base64url but "+/+/" in
      // standard base64 — decoding with the wrong alphabet corrupts the data.
      const bytes = Buffer.from([0xfb, 0xff, 0xbf]);
      mockGet.mockResolvedValue({
        data: {
          id: "msg-b64",
          snippet: "x",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "application/octet-stream",
                filename: "raw.bin",
                body: { attachmentId: "att-b64", size: bytes.length },
              },
            ],
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "x" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });
      mockAttachmentsGet.mockResolvedValue({
        data: { size: bytes.length, data: bytes.toString("base64url") },
      });

      const result = await adapter.getAttachment("msg-b64", "att-b64");

      expect(Array.from(result.data)).toEqual([0xfb, 0xff, 0xbf]);
    });

    it("throws a re-read hint when the attachmentId is not in the message", async () => {
      mockGet.mockResolvedValue({
        data: {
          id: "msg-stale",
          snippet: "x",
          labelIds: [],
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "application/pdf",
                filename: "current.pdf",
                body: { attachmentId: "att-current", size: 1 },
              },
            ],
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "x" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      await expect(
        adapter.getAttachment("msg-stale", "att-gone"),
      ).rejects.toThrow(/re-read/i);
      // Must not attempt the bytes fetch when the id can't be resolved.
      expect(mockAttachmentsGet).not.toHaveBeenCalled();
    });
  });

  describe("search", () => {
    it("builds Gmail query from DSL fields", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.search({ from: "alice", subject: "meeting" });

      expect(mockList).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 20,
        q: "from:alice subject:meeting",
        labelIds: undefined,
      });
    });

    it("respects limit parameter", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });

      await adapter.search({ from: "test", limit: 5 });

      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 5 }),
      );
    });
  });

  describe("folder mapping", () => {
    it("maps canonical folders to Gmail label IDs", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });
      await adapter.list({ folder: "DRAFTS", limit: 5 });
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ labelIds: ["DRAFT"] }),
      );
    });

    it("rejects custom folder names", async () => {
      await expect(
        adapter.list({ folder: "CUSTOM_LABEL" as never }),
      ).rejects.toThrow(/unknown folder/i);
    });
  });

  describe("search DSL → Gmail query", () => {
    it("combines from, subject, unread, sinceDays", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });
      await adapter.search({
        from: "alice@example.com",
        subject: "invoice",
        unread: true,
        sinceDays: 7,
      });
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "from:alice@example.com subject:invoice is:unread newer_than:7d",
        }),
      );
    });

    it("escapes spaces in subject", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });
      await adapter.search({ subject: "monthly report" });
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'subject:"monthly report"' }),
      );
    });

    it("escapes backslashes in quoted values (CodeQL: incomplete string escaping)", async () => {
      mockList.mockResolvedValue({ data: { messages: [] } });
      // A backslash must be doubled so a trailing "\" can't escape the closing
      // quote. Input `re: a\b` → `subject:"re: a\\b"`.
      await adapter.search({ subject: "re: a\\b" });
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'subject:"re: a\\\\b"' }),
      );
    });

    it("requires at least one field", async () => {
      await expect(adapter.search({})).rejects.toThrow(/at least one/i);
    });
  });

  describe("replyTo sets In-Reply-To AND References", () => {
    it("includes both headers in the raw message", async () => {
      mockDraftsCreate.mockResolvedValue({ data: { id: "draft1" } });
      await adapter.draft({
        to: "alice@example.com",
        subject: "Re: hello",
        body: "thanks",
        replyTo: "<original-id@mail.example>",
      });
      const raw = mockDraftsCreate.mock.calls[0][0].requestBody.message.raw;
      const decoded = Buffer.from(raw, "base64url").toString("utf-8");
      expect(decoded).toContain("In-Reply-To: <original-id@mail.example>");
      expect(decoded).toContain("References: <original-id@mail.example>");
    });
  });

  describe("draft", () => {
    it("creates a draft email", async () => {
      mockDraftsCreate.mockResolvedValue({
        data: { id: "draft-123" },
      });

      const result = await adapter.draft({
        to: "bob@example.com",
        subject: "Draft subject",
        body: "Draft body",
      });

      expect(result).toEqual({ draftId: "draft-123" });

      expect(mockDraftsCreate).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          message: {
            raw: expect.any(String),
          },
        },
      });

      // Verify the raw message content
      const call = mockDraftsCreate.mock.calls[0][0];
      const raw = Buffer.from(
        call.requestBody.message.raw,
        "base64url",
      ).toString("utf-8");
      expect(raw).toContain("To: bob@example.com");
      expect(raw).toContain("Subject: Draft subject");
      expect(raw).toContain("Draft body");
    });

    it("includes In-Reply-To header when replyTo is provided", async () => {
      mockDraftsCreate.mockResolvedValue({
        data: { id: "draft-reply" },
      });

      await adapter.draft({
        to: "bob@example.com",
        subject: "Re: Original",
        body: "Reply body",
        replyTo: "<original-msg-id@example.com>",
      });

      const call = mockDraftsCreate.mock.calls[0][0];
      const raw = Buffer.from(
        call.requestBody.message.raw,
        "base64url",
      ).toString("utf-8");
      expect(raw).toContain("In-Reply-To: <original-msg-id@example.com>");
    });
  });

  describe("send", () => {
    it("sends an email and returns messageId", async () => {
      mockSend.mockResolvedValue({
        data: { id: "sent-456" },
      });

      const result = await adapter.send({
        to: "bob@example.com",
        subject: "Sent subject",
        body: "Sent body",
      });

      expect(result).toEqual({ messageId: "sent-456" });

      expect(mockSend).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          raw: expect.any(String),
        },
      });

      // Verify the raw message content
      const call = mockSend.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.raw, "base64url").toString(
        "utf-8",
      );
      expect(raw).toContain("To: bob@example.com");
      expect(raw).toContain("Subject: Sent subject");
      expect(raw).toContain("Sent body");
    });

    it("includes In-Reply-To header when replyTo is provided", async () => {
      mockSend.mockResolvedValue({
        data: { id: "sent-reply" },
      });

      await adapter.send({
        to: "bob@example.com",
        subject: "Re: Thread",
        body: "Reply",
        replyTo: "<thread-id@example.com>",
      });

      const call = mockSend.mock.calls[0][0];
      const raw = Buffer.from(call.requestBody.raw, "base64url").toString(
        "utf-8",
      );
      expect(raw).toContain("In-Reply-To: <thread-id@example.com>");
    });
  });

  describe("MIME header injection prevention", () => {
    beforeEach(() => {
      mockDraftsCreate.mockResolvedValue({ data: { id: "draft-safe" } });
    });

    function getRawLines(mockFn: ReturnType<typeof vi.fn>): string[] {
      const call = mockFn.mock.calls[0][0];
      const raw = Buffer.from(
        call.requestBody.message.raw,
        "base64url",
      ).toString("utf-8");
      return raw.split("\r\n");
    }

    it("strips CRLF from the to field to prevent header injection", async () => {
      await adapter.draft({
        to: "victim@example.com\r\nBcc: attacker@evil.com",
        subject: "Hello",
        body: "Body",
      });

      const lines = getRawLines(mockDraftsCreate);
      // No standalone Bcc header line should exist
      expect(lines.every((line) => !line.startsWith("Bcc:"))).toBe(true);
    });

    it("strips CRLF from the subject field to prevent header injection", async () => {
      await adapter.draft({
        to: "bob@example.com",
        subject: "Innocent\r\nBcc: attacker@evil.com",
        body: "Body",
      });

      const lines = getRawLines(mockDraftsCreate);
      expect(lines.every((line) => !line.startsWith("Bcc:"))).toBe(true);
    });

    it("strips CRLF from the replyTo field to prevent header injection", async () => {
      await adapter.draft({
        to: "bob@example.com",
        subject: "Re: Test",
        body: "Body",
        replyTo: "<msg-id@example.com>\r\nBcc: attacker@evil.com",
      });

      const lines = getRawLines(mockDraftsCreate);
      expect(lines.every((line) => !line.startsWith("Bcc:"))).toBe(true);
    });

    it("strips lone LF from header fields", async () => {
      await adapter.draft({
        to: "victim@example.com\nX-Injected: yes",
        subject: "Hello",
        body: "Body",
      });

      const lines = getRawLines(mockDraftsCreate);
      expect(lines.every((line) => !line.startsWith("X-Injected:"))).toBe(true);
    });
  });

  describe("base64url encoding/decoding", () => {
    it("correctly decodes base64url body with special characters", async () => {
      const originalText = "Hello! Special chars: +/= and umlauts: äöü";
      mockGet.mockResolvedValue({
        data: {
          id: "msg-special",
          snippet: "Special",
          labelIds: [],
          payload: {
            mimeType: "text/plain",
            body: { data: base64url(originalText) },
            headers: [
              { name: "From", value: "a@b.com" },
              { name: "To", value: "c@d.com" },
              { name: "Subject", value: "Special" },
              { name: "Date", value: "Mon, 7 Apr 2026 10:00:00 +0000" },
            ],
          },
        },
      });

      const result = await adapter.read("msg-special");

      expect(result.body).toBe(originalText);
    });
  });
});
