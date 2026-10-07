import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db-contract";
import { deleteAttentionEvent } from "../events";

describe("deleteAttentionEvent", () => {
  it("deletes only the matching notification inside the active tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as DbClient;

    await expect(deleteAttentionEvent(client, "account-a", "event-123")).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM attention_events WHERE id = $1 AND account_id = $2",
      ["event-123", "account-a"],
    );
  });

  it("reports a missing or cross-tenant event without claiming deletion", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const client = { query } as unknown as DbClient;

    await expect(deleteAttentionEvent(client, "account-b", "event-123")).resolves.toBe(false);
  });
});
