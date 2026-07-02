export type Folder = "INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM";

export interface EmailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailFull extends EmailSummary {
  cc: string;
  body: string;
  attachments: EmailAttachment[];
}

export interface ListOptions {
  folder?: Folder;
  limit?: number;
  unreadOnly?: boolean;
}

export interface SearchOptions {
  from?: string;
  to?: string;
  subject?: string;
  unread?: boolean;
  sinceDays?: number;
  folder?: Folder;
  limit?: number;
}

export interface ComposeOptions {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}

export interface EmailAdapter {
  list(opts: ListOptions): Promise<EmailSummary[]>;
  read(id: string): Promise<EmailFull>;
  search(opts: SearchOptions): Promise<EmailSummary[]>;
  draft(opts: ComposeOptions): Promise<{ draftId: string }>;
  // messageId is null when the provider's send API does not return a real
  // id for the message it just sent (e.g. Microsoft Graph's POST /sendMail
  // answers 202 Accepted with no Location header for a direct, non-reply
  // send). Adapters must NOT fabricate an id in that case — null signals
  // honestly that no id is available.
  send(opts: ComposeOptions): Promise<{ messageId: string | null }>;
  getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ filename: string; mimeType: string; data: Buffer }>;
}
