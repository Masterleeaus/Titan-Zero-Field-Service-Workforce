"use client";

import Link from "next/link";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";

type ActivityEvent = {
  id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  summary: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
};

type ActivityFilter = "read" | "unread" | "urgent" | "crew" | "requests" | "estimates" | "invoices";
type CardTone = "attention" | "positive" | "critical" | "neutral";

const FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: "read", label: "Read" },
  { id: "unread", label: "Unread" },
  { id: "urgent", label: "Urgent" },
  { id: "crew", label: "Crew" },
  { id: "requests", label: "Requests" },
  { id: "estimates", label: "Estimates" },
  { id: "invoices", label: "Invoices" },
];

function typeGroup(type: string): "messages" | "requests" | "estimates" | "invoices" | "other" {
  if (type.startsWith("booking_request.")) return "messages";
  if (type.startsWith("estimate.")) return "estimates";
  if (type.startsWith("invoice.")) return "invoices";
  if (type.startsWith("request.")) return "requests";
  return "other";
}

function toneFor(event: ActivityEvent): CardTone {
  const signal = `${event.type} ${event.title} ${event.summary ?? ""}`.toLowerCase();
  if (/overdue|sla|emergency|incident|safety|breach|unavailable|critical/.test(signal)) return "critical";
  if (/paid|approved|completed|verified|recovered/.test(signal)) return "positive";
  if (/reassign|conflict|delayed|late|shortage|booking_request|request/.test(signal)) return "attention";
  return "neutral";
}

function isCrewEvent(event: ActivityEvent): boolean {
  const details = `${event.type} ${event.entity_type ?? ""} ${event.title} ${event.summary ?? ""}`.toLowerCase();
  return /\\b(crew|worker|technician|field lead|dispatcher)\\b/.test(details);
}

function eventLabel(type: string): string {
  return type.replace(/[._]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeHref(href: string | null): string {
  return href?.startsWith("/app/") ? href : "/app/activity";
}

function contextualSummary(event: ActivityEvent): string {
  const source = event.summary?.trim() ?? "";
  const contextByType: Record<string, string> = {
    "booking_request.created": "Review the requested scope, timing, and customer details in the source record before scheduling.",
    "estimate.opened": "The estimate was viewed; this event does not mean it was accepted. Check its current status before following up.",
    "estimate.approved": "The estimate was approved. Review its accepted scope and determine the next scheduling step.",
    "estimate.declined": "The estimate was declined. Review the source record to decide whether a follow-up or revision is appropriate.",
    "invoice.opened": "The invoice was viewed; this event does not confirm payment. Check the invoice record for its current balance.",
    "invoice.paid": "Payment was recorded. Check the invoice record for the amount, receipt, and remaining balance.",
    "invoice.partial": "A partial payment was recorded. Check the invoice record for the current amount due.",
  };
  const context = contextByType[event.type]
    ?? "Open the source record to review the current status and any available follow-up actions.";
  const expandedContext = context.length >= 100
    ? context
    : `${context} Verify the latest record details before taking action.`;
  return [source, expandedContext].filter(Boolean).join(" ");
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16l-6.2 7.1v5.2l-3.6 1.8v-7L4 5Z" />
    </svg>
  );
}

export function ActivityStream() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const searchParams = useSearchParams();
  const tab: "messages" | "notifications" = searchParams.get("tab") === "notifications" ? "notifications" : "messages";
  const [selectedFilters, setSelectedFilters] = useState<ActivityFilter[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeEvent, setActiveEvent] = useState<ActivityEvent | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [touchedId, setTouchedId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const conversationId = useRef<string | null>(null);
  const interactionIds = useRef(new Map<string, string>());
  const modalRef = useRef<HTMLElement>(null);
  const touchStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const skipClick = useRef(false);
  const clearHint = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/attention/events?limit=100", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Activity could not be loaded.");
      const json = await response.json();
      setEvents(Array.isArray(json?.data) ? json.data as ActivityEvent[] : []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Activity could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 50_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => () => {
    if (clearHint.current) window.clearTimeout(clearHint.current);
  }, []);

  useEffect(() => {
    if (!activeEvent) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = modalRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [];
    const first = focusable()[0];
    first?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveEvent(null);
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(focusable());
      if (!items.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [activeEvent]);

  const visibleEvents = useMemo(() => {
    let rows = events;
    rows = rows.filter((event) => tab === "messages"
      ? typeGroup(event.type) === "messages"
      : typeGroup(event.type) !== "messages");

    const read = selectedFilters.includes("read");
    const unread = selectedFilters.includes("unread");
    if (read !== unread) rows = rows.filter((event) => read ? !!event.read_at : !event.read_at);
    if (selectedFilters.includes("urgent")) rows = rows.filter((event) => toneFor(event) === "critical");
    if (selectedFilters.includes("crew")) rows = rows.filter(isCrewEvent);

    const kinds = selectedFilters.filter((filter) => filter === "requests" || filter === "estimates" || filter === "invoices");
    if (kinds.length) rows = rows.filter((event) => kinds.some((kind) =>
      kind === "requests"
        ? typeGroup(event.type) === "requests" || typeGroup(event.type) === "messages"
        : typeGroup(event.type) === kind,
    ));
    return rows;
  }, [events, selectedFilters, tab]);

  const pinnedEvents = useMemo(() => visibleEvents
    .filter((event) => !event.read_at)
    .sort((left, right) => {
      const rank: Record<CardTone, number> = { critical: 0, attention: 1, neutral: 2, positive: 3 };
      const priorityDifference = rank[toneFor(left)] - rank[toneFor(right)];
      if (priorityDifference !== 0) return priorityDifference;
      return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
    })
    .slice(0, 3), [visibleEvents]);
  const pinnedIds = useMemo(() => new Set(pinnedEvents.map((event) => event.id)), [pinnedEvents]);
  const activityEvents = useMemo(() => visibleEvents.filter((event) => !pinnedIds.has(event.id)), [visibleEvents, pinnedIds]);

  function notify(text: string) {
    setToast(text);
    window.setTimeout(() => setToast(""), 4500);
  }

  async function markRead(event: ActivityEvent) {
    if (event.read_at) return;
    try {
      const response = await fetch(`/api/v1/attention/events/${encodeURIComponent(event.id)}/read`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) return;
      const readAt = new Date().toISOString();
      setEvents((current) => current.map((item) => item.id === event.id ? { ...item, read_at: readAt } : item));
    } catch {
      // The item stays unread if the existing read endpoint is unavailable.
    }
  }

  function openWizard(event: ActivityEvent) {
    setActiveEvent(event);
    setWizardStep(0);
    setTouchedId(null);
    void markRead(event);
  }

  async function deleteEvent(event: ActivityEvent) {
    setBusyId(event.id);
    try {
      const response = await fetch(`/api/v1/attention/events/${encodeURIComponent(event.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? result?.error ?? "This notification could not be deleted.");
      setEvents((current) => current.filter((item) => item.id !== event.id));
      setActiveEvent((current) => current?.id === event.id ? null : current);
      notify("Deleted from Activity.");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "This notification could not be deleted.");
    } finally {
      setBusyId(null);
      setTouchedId(null);
    }
  }

  async function sendToZero(event: ActivityEvent) {
    setBusyId(event.id);
    try {
      conversationId.current ??= crypto.randomUUID();
      const messageId = interactionIds.current.get(event.id) ?? crypto.randomUUID();
      interactionIds.current.set(event.id, messageId);
      const details = [
        `Handle this Titan Field activity item: ${event.title}.`,
        event.summary ? `Current context: ${event.summary}` : "No additional context is recorded for this item.",
        `Source type: ${event.type}. Related record: ${event.entity_type ?? "unknown"} ${event.entity_id ?? "unknown"}.`,
      ].join(" ");
      const response = await fetch("/api/v1/zero/interactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          surface: "zero",
          conversation_id: conversationId.current,
          text: details,
          client_message_id: messageId,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error ?? "Zero could not accept this item.");
      await markRead(event);
      setActiveEvent((current) => current?.id === event.id ? null : current);
      notify("Sent to Zero. The item remains in Activity.");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "Zero could not accept this item.");
    } finally {
      setBusyId(null);
      setTouchedId(null);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLElement>, item: ActivityEvent) {
    touchStart.current = { id: item.id, x: event.clientX, y: event.clientY };
    setTouchedId(item.id);
    if (clearHint.current) window.clearTimeout(clearHint.current);
  }

  function onPointerUp(event: PointerEvent<HTMLElement>, item: ActivityEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || start.id !== item.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.25) {
      clearHint.current = window.setTimeout(() => setTouchedId(null), 2200);
      return;
    }
    event.preventDefault();
    skipClick.current = true;
    window.setTimeout(() => { skipClick.current = false; }, 800);
    if (dx < 0) void deleteEvent(item);
    else void sendToZero(item);
  }

  function toggleFilter(filter: ActivityFilter) {
    setSelectedFilters((current) => current.includes(filter)
      ? current.filter((item) => item !== filter)
      : [...current, filter]);
  }

  return (
    <section className="p7-activity" aria-labelledby="field-activity-title">
      <header className="p7-activity__header">
        <div>
          <h1 id="field-activity-title">Activity</h1>
        </div>
        <div className="p7-activity__filter-wrap">
          <button
            type="button"
            className={`p7-activity__filter-button${filterOpen ? " is-open" : ""}`}
            aria-label="Filter activity"
            aria-expanded={filterOpen}
            aria-controls="field-activity-filters"
            onClick={() => setFilterOpen((open) => !open)}
          >
            <FilterIcon />
            {selectedFilters.length > 0 && <span>{selectedFilters.length}</span>}
          </button>
          {filterOpen && (
            <div id="field-activity-filters" className="p7-activity__filter-menu" role="group" aria-label="Activity filters">
              {FILTERS.map((filter) => (
                <label key={filter.id}>
                  <input type="checkbox" checked={selectedFilters.includes(filter.id)} onChange={() => toggleFilter(filter.id)} />
                  <span>{filter.label}</span>
                </label>
              ))}
              <button type="button" onClick={() => setSelectedFilters([])}>Clear filters</button>
            </div>
          )}
        </div>
      </header>

      <div className="p7-activity__summary" aria-live="polite">
        <span>{visibleEvents.length} {visibleEvents.length === 1 ? "item" : "items"}</span>
      </div>

      {error && (
        <div className="p7-activity__state p7-activity__state--error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => { setLoading(true); void load(); }}>Try again</button>
        </div>
      )}

      {loading ? (
        <div className="p7-activity__state" role="status">Loading activity…</div>
      ) : !error && visibleEvents.length === 0 ? (
        <div className="p7-activity__state">
          {tab === "messages"
            ? "No booking request messages match this view."
            : "No notifications match the current filters."}
        </div>
      ) : (
        <div className="p7-activity__content" aria-label={tab === "messages" ? "Messages" : "Notifications"}>
          {pinnedEvents.length > 0 && (
            <section className="p7-activity__pinned" aria-labelledby="field-pinned-title">
              <h2 id="field-pinned-title">Pinned · Unread</h2>
              <div className="p7-activity__list">
                {pinnedEvents.map((event) => renderEventCard(event))}
              </div>
            </section>
          )}
          {activityEvents.length > 0 && (
            <section className="p7-activity__recent" aria-labelledby="field-recent-title">
              <h2 id="field-recent-title">More activity</h2>
              <div className="p7-activity__list">
                {activityEvents.map((event) => renderEventCard(event))}
              </div>
            </section>
          )}
        </div>
      )}

      {toast && (
        <div className="p7-activity__toast" role="status">
          <span>{toast}</span>
        </div>
      )}

      {activeEvent && (
        <div className="p7-field-modal__backdrop" role="presentation" onMouseDown={(mouseEvent) => {
          if (mouseEvent.target === mouseEvent.currentTarget) setActiveEvent(null);
        }}>
          <section ref={modalRef} className="p7-field-modal" role="dialog" aria-modal="true" aria-labelledby="activity-wizard-title" tabIndex={-1}>
            <header className="p7-field-modal__header">
              <button type="button" onClick={() => setActiveEvent(null)} aria-label="Close activity details">×</button>
              <div>
                <span>Step {wizardStep + 1} of 2</span>
                <div className="p7-field-modal__progress"><i style={{ width: wizardStep === 0 ? "50%" : "100%" }} /></div>
              </div>
            </header>
            {wizardStep === 0 ? (
              <div className="p7-field-modal__content">
                <p className="p7-field-modal__eyebrow">{eventLabel(activeEvent.type)}</p>
                <h2 id="activity-wizard-title">{activeEvent.title}</h2>
                <p>{contextualSummary(activeEvent)}</p>
                <dl>
                  <div><dt>Record</dt><dd>{activeEvent.entity_type ?? "Activity"}{activeEvent.entity_id ? ` · ${activeEvent.entity_id}` : ""}</dd></div>
                  <div><dt>Received</dt><dd>{new Date(activeEvent.created_at).toLocaleString()}</dd></div>
                </dl>
                <div className="p7-field-modal__actions">
                  <button type="button" onClick={() => setWizardStep(1)}>Continue</button>
                  <Link href={safeHref(activeEvent.href) as Route} onClick={() => setActiveEvent(null)}>Open source record</Link>
                </div>
              </div>
            ) : (
              <div className="p7-field-modal__content">
                <p className="p7-field-modal__eyebrow">Choose an action</p>
                <h2 id="activity-wizard-title">How should Zero help?</h2>
                <p>The activity details will be sent to the existing Zero interaction runtime. Zero will respond according to the authority available for this path.</p>
                <div className="p7-field-modal__actions">
                  <button type="button" disabled={busyId === activeEvent.id} onClick={() => void sendToZero(activeEvent)}>
                    {busyId === activeEvent.id ? "Sending…" : "Send to Zero"}
                  </button>
                  <button type="button" className="secondary" onClick={() => setActiveEvent(null)}>Close</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );

  function renderEventCard(event: ActivityEvent) {
    const tone = toneFor(event);
    return (
      <article
        key={event.id}
        className={`p7-activity-card p7-activity-card--${tone}${event.read_at ? " is-read" : " is-unread"}${touchedId === event.id ? " is-touched" : ""}`}
        onPointerDown={(pointerEvent) => onPointerDown(pointerEvent, event)}
        onPointerUp={(pointerEvent) => onPointerUp(pointerEvent, event)}
        onPointerCancel={() => { touchStart.current = null; setTouchedId(null); }}
        onClick={() => {
          if (skipClick.current) { skipClick.current = false; return; }
          openWizard(event);
        }}
        onKeyDown={(keyEvent) => {
          if (keyEvent.target !== keyEvent.currentTarget) return;
          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
            keyEvent.preventDefault();
            openWizard(event);
          }
        }}
        role="group"
        tabIndex={0}
        aria-label={`Activity item: ${event.title}. ${event.summary ?? ""}`}
      >
        <span className="p7-activity-card__tone" aria-hidden="true" />
        <div className="p7-activity-card__body">
          <div className="p7-activity-card__meta">
            <span>{eventLabel(event.type)}</span>
            {!event.read_at && <span className="p7-activity-card__unread">Unread</span>}
          </div>
          <h2>{event.title}</h2>
          <p>{contextualSummary(event)}</p>
          <div className="p7-activity-card__record">
            <span>{event.entity_type ?? "Activity"}{event.entity_id ? ` · ${event.entity_id}` : ""}</span>
            <time dateTime={event.created_at}>{formatTime(event.created_at)}</time>
          </div>
        </div>
        <div className="p7-activity-card__touch-actions">
          <button type="button" disabled={busyId === event.id} onClick={(clickEvent) => { clickEvent.stopPropagation(); void deleteEvent(event); }} aria-label="Delete notification">← Delete</button>
          <button type="button" disabled={busyId === event.id} onClick={(clickEvent) => { clickEvent.stopPropagation(); void sendToZero(event); }} aria-label="Send to Zero to handle">Send to Zero →</button>
        </div>
      </article>
    );
  }
}
