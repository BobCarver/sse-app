/**
 * Admin-issued credentials for DJs, judges and scoreboards.
 *
 * An admin issues a secret for a client id (dj<trackId>, sb<trackId>,
 * judge<judgeId>) and hands it out as a link. Opening the link stores the secret
 * in an HttpOnly cookie; every request is authenticated by looking up the
 * secret's hash. Only hashes are stored. Revoking takes effect immediately.
 *
 * The lookup table is an in-memory cache backed by an optional persistence
 * layer, so a database blip never blocks scoring once credentials are loaded.
 */

export const CLIENT_ID_PATTERN = /^(dj|judge|sb)\d+$/;

export type ClientKind = "dj" | "judge" | "sb";

export interface Credential {
  id: number;
  clientId: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CredentialPersistence {
  insert(
    c: { clientId: string; secretHash: string; label?: string },
  ): Promise<{ id: number; createdAt: Date }>;
  revoke(id: number): Promise<boolean>;
  loadAll(): Promise<Array<Credential & { secretHash: string }>>;
}

export function parseClientId(
  clientId: string,
): { kind: ClientKind; num: number } | undefined {
  const m = CLIENT_ID_PATTERN.exec(clientId);
  if (!m) return undefined;
  return { kind: m[1] as ClientKind, num: Number(clientId.slice(m[1].length)) };
}

/** Where a client's link should land. */
export function pageFor(clientId: string): string | undefined {
  const p = parseClientId(clientId);
  if (!p) return undefined;
  return { dj: "/dj", judge: "/judge", sb: "/scoreboard" }[p.kind];
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 256 bits of randomness, base64url. */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export class Credentials {
  private byHash = new Map<string, Credential>();
  private byId = new Map<number, Credential>();
  private nextId = 1; // memory mode only
  private loaded: boolean;

  constructor(private store?: CredentialPersistence) {
    this.loaded = !store;
  }

  /** Load from the database once; retried on the next call if it failed. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.store) return;
    for (const { secretHash, ...c } of await this.store.loadAll()) {
      this.add(secretHash, c);
    }
    this.loaded = true;
  }

  private add(hash: string, c: Credential) {
    this.byHash.set(hash, c);
    this.byId.set(c.id, c);
  }

  /** Create a credential. The secret is returned once and never stored. */
  async issue(
    clientId: string,
    label?: string,
  ): Promise<{ credential: Credential; secret: string }> {
    if (!parseClientId(clientId)) {
      throw new Error(`invalid client id: ${clientId}`);
    }
    await this.ensureLoaded();
    const secret = newSecret();
    const secretHash = await hashSecret(secret);
    const { id, createdAt } = this.store
      ? await this.store.insert({ clientId, secretHash, label })
      : { id: this.nextId++, createdAt: new Date() };
    const credential: Credential = {
      id,
      clientId,
      label: label ?? null,
      createdAt,
      revokedAt: null,
    };
    this.add(secretHash, credential);
    return { credential, secret };
  }

  /** Revoke by id. Returns false if unknown or already revoked. */
  async revoke(id: number): Promise<boolean> {
    await this.ensureLoaded();
    const c = this.byId.get(id);
    if (!c || c.revokedAt) return false;
    if (this.store) await this.store.revoke(id);
    c.revokedAt = new Date(); // same object the hash lookup returns
    return true;
  }

  list(): Credential[] {
    return [...this.byId.values()].sort((a, b) => a.id - b.id);
  }

  /** The active credential for a secret, or undefined. */
  async authenticate(secret: string): Promise<Credential | undefined> {
    if (!secret) return undefined;
    await this.ensureLoaded();
    const c = this.byHash.get(await hashSecret(secret));
    return c && !c.revokedAt ? c : undefined;
  }
}
