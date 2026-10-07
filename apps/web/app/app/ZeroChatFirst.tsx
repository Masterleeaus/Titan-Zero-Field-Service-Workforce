"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CaptureLink } from "@/components/CaptureLink";

type Pulse = {
  attention: number;
  jobs: number;
  onTrack: number;
  exceptions: number;
  activeWorkers: number;
  waitingWorkers: number;
  approvals: number;
};

function LensIcon({ kind }: { kind: "chat" | "vision" | "voice" }) {
  if (kind === "chat") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-3 2v-5.1A7.5 7.5 0 1 1 20 11.5Z" /></svg>;
  }
  if (kind === "vision") {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h3l1.4-2h7.2l1.4 2h3v12H4z" /><circle cx="12" cy="13.5" r="3.5" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" /></svg>;
}

export function ZeroChatFirst({
  pulse,
  conversationId,
  continuationToken,
  compact = false,
}: {
  pulse?: Pulse;
  conversationId?: string;
  continuationToken?: string;
  compact?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const conversation = useRef<string | undefined>(conversationId);
  const pending = useRef<{ text: string; id: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    conversation.current ??= crypto.randomUUID();
    if (pending.current?.text !== text) pending.current = { text, id: crypto.randomUUID() };
    setBusy(true);
    setStatus("Submitting…");
    try {
      const response = await fetch("/api/v1/zero/interactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surface: "zero",
          conversation_id: conversation.current,
          text,
          client_message_id: pending.current.id,
          continuation_token: continuationToken,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Interaction rejected");
      setStatus("Request recorded. The persisted status appears below.");
      pending.current = null;
      setMessage("");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <section className="p7-zero-composer" aria-label="Chat with Titan Zero">
        <form onSubmit={send} role="search" aria-label="Chat with Titan Zero" className="p7-zero-composer__form">
          <label htmlFor="field-zero-chat" className="sr-only">Ask Titan Zero</label>
          <input
            ref={input}
            id="field-zero-chat"
            name="q"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask Zero anything…"
            autoComplete="off"
          />
          <button type="submit" disabled={busy || !message.trim()} aria-label="Send to Zero" className="p7-zero-send">
            Send
          </button>
        </form>
        <div className="p7-zero-lenses" aria-label="Input modes">
          <button type="button" onClick={() => input.current?.focus()} aria-label="Chat with Zero">
            <LensIcon kind="chat" /> <span>Chat</span>
          </button>
          <CaptureLink className="p7-zero-lens-link" aria-label="Capture a photo">
            <LensIcon kind="vision" /> <span>Vision</span>
          </CaptureLink>
          <CaptureLink className="p7-zero-lens-link" aria-label="Capture audio">
            <LensIcon kind="voice" /> <span>Voice</span>
          </CaptureLink>
        </div>
        <p className="p7-zero-status" role="status" aria-live="polite">{status}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="zero-heading" style={{ display: "grid", gap: "var(--space-4)", marginBottom: "var(--space-5)" }}>
      <div>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: "var(--text-sm)", letterSpacing: ".08em" }}>ZERO</p>
        <h1 id="zero-heading" style={{ margin: "var(--space-1) 0 0" }}>What needs attention?</h1>
      </div>
      <form onSubmit={send} role="search" aria-label="Chat with Zero" style={{ display: "flex", gap: "var(--space-2)" }}>
        <label htmlFor="zero-chat" className="sr-only">Chat with Zero</label>
        <input id="zero-chat" name="q" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Chat with Zero…" autoComplete="off" style={{ flex: 1, minHeight: 48, padding: "0 var(--space-3)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-card)", color: "inherit", fontSize: "1rem" }} />
        <button type="submit" disabled={busy || !message.trim()} aria-label="Send to Zero" style={{ minWidth: 48, minHeight: 48 }}>Send</button>
      </form>
      <p role="status">{status}</p>
      {pulse && <div aria-label="Business pulse" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: "var(--space-2)" }}>
        <Pulse label="Needs your attention" value={`${pulse.attention} decisions`} />
        <Pulse label="Today's business" value={`${pulse.jobs} jobs · ${pulse.onTrack} on track · ${pulse.exceptions} exceptions`} />
        <Pulse label="Workforce" value={`${pulse.activeWorkers} active · ${pulse.waitingWorkers} waiting · ${pulse.approvals} need approval`} />
      </div>}
    </section>
  );
}

function Pulse({ label, value }: { label: string; value: string }) {
  return <div style={{ padding: "var(--space-3)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-card)" }}><strong style={{ display: "block", fontSize: "var(--text-sm)" }}>{label}</strong><span style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>{value}</span></div>;
}
