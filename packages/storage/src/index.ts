export type StorageDialect = "sqlite" | "postgres" | "mysql";
export interface QueryResult<T = Record<string, unknown>> { rows: T[]; rowCount: number; }
export interface StorageTransactionOptions {
  /** Absolute performance.now() deadline for queueing and SQLite writer-lock admission. */
  acquireDeadlineMs?: number;
}
export interface StorageClient {
  readonly dialect: StorageDialect;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: StorageClient) => Promise<T>, options?: StorageTransactionOptions): Promise<T>;
  close(): Promise<void>;
}
export interface CompanyStorage {
  readonly companyId: string;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: CompanyStorage) => Promise<T>): Promise<T>;
}

export function requireCompanyId(value: string | undefined | null): string {
  const companyId = value?.trim();
  if (!companyId) throw new Error("company_id is required for company-scoped storage");
  return companyId;
}

export function normalizeCompanyContext(input: { company_id?: string; tenant_company_id?: string; tenant_id?: string }): string {
  return requireCompanyId(input.company_id ?? input.tenant_company_id ?? input.tenant_id);
}
export { createSqliteStorage, openExistingSqliteStorage } from "./sqlite-client.js";

export function forCompany(storage: StorageClient, rawCompanyId: string): CompanyStorage {
  const companyId = requireCompanyId(rawCompanyId);
  return {
    companyId,
    query(sql, params = []) { return storage.query(sql, params); },
    transaction(fn) { return storage.transaction(tx => fn(forCompany(tx, companyId))); },
  };
}

export * from "./company-storage-resolver.js";
export * from "./company-placement-registry.js";
export * from "./company-placement-provisioner.js";
export * from "./company-placement-backup.js";
export * from "./company-placement-operation-gate.js";
export * from "./company-store-opener.js";
export * from "./company-file-store-opener.js";
export * from "./company-file-storage-resolver.js";
