import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  type Credential,
  type CredentialPersistence,
  Credentials,
  hashSecret,
  pageFor,
  parseClientId,
} from "../../src/credentials.ts";

Deno.test("client ids: parse and landing page", () => {
  assertEquals(parseClientId("judge12"), { kind: "judge", num: 12 });
  assertEquals(parseClientId("dj1"), { kind: "dj", num: 1 });
  assertEquals(parseClientId("sb3"), { kind: "sb", num: 3 });
  for (
    const bad of [
      "",
      "judge",
      "admin1",
      "dj-1",
      "judge2x",
      "xdj1",
      "DJ1",
      "dj1 ",
    ]
  ) {
    assertEquals(parseClientId(bad), undefined, bad);
  }
  assertEquals([pageFor("dj1"), pageFor("judge2"), pageFor("sb3")], [
    "/dj",
    "/judge",
    "/scoreboard",
  ]);
  assertEquals(pageFor("nope"), undefined);
});

Deno.test("issue -> authenticate -> revoke", async () => {
  const creds = new Credentials();
  const { credential, secret } = await creds.issue("judge2", "Alice");
  assertEquals([credential.clientId, credential.label, credential.revokedAt], [
    "judge2",
    "Alice",
    null,
  ]);

  assertEquals((await creds.authenticate(secret))?.id, credential.id);
  assertEquals(await creds.authenticate(secret + "x"), undefined);
  assertEquals(await creds.authenticate(""), undefined);

  assertEquals(await creds.revoke(credential.id), true);
  assertEquals(await creds.authenticate(secret), undefined); // immediate
  assertEquals(await creds.revoke(credential.id), false); // already revoked
  assertEquals(await creds.revoke(999), false); // unknown
});

Deno.test("secrets are random, long, and never listed", async () => {
  const creds = new Credentials();
  const a = await creds.issue("dj1");
  const b = await creds.issue("dj1");
  assertNotEquals(a.secret, b.secret);
  assert(a.secret.length >= 43, "256 bits of base64url");
  assert(/^[A-Za-z0-9_-]+$/.test(a.secret));
  // two devices can hold credentials for the same client id; revoking one leaves the other
  await creds.revoke(a.credential.id);
  assertEquals((await creds.authenticate(b.secret))?.clientId, "dj1");
  assertEquals(JSON.stringify(creds.list()).includes(a.secret), false);
});

Deno.test("issue rejects invalid client ids", async () => {
  const creds = new Credentials();
  await assertRejects(() => creds.issue("admin1"), Error, "invalid client id");
});

function fakeStore(rows: Array<Credential & { secretHash: string }> = []) {
  const inserted: Array<
    { clientId: string; secretHash: string; label?: string }
  > = [];
  const revoked: number[] = [];
  let failLoads = 0;
  let loads = 0;
  const store: CredentialPersistence = {
    insert: (c) => {
      inserted.push(c);
      return Promise.resolve({
        id: 100 + inserted.length,
        createdAt: new Date(),
      });
    },
    revoke: (id) => {
      revoked.push(id);
      return Promise.resolve(true);
    },
    loadAll: () => {
      loads++;
      return failLoads-- > 0
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(rows);
    },
  };
  return {
    store,
    inserted,
    revoked,
    failNext: (n: number) => (failLoads = n),
    loads: () => loads,
  };
}

Deno.test("persistence: only the hash is stored", async () => {
  const s = fakeStore();
  const creds = new Credentials(s.store);
  const { secret, credential } = await creds.issue("sb1", "Main stage");
  assertEquals(credential.id, 101);
  assertEquals(s.inserted.length, 1);
  assertEquals(s.inserted[0].secretHash, await hashSecret(secret));
  assertEquals(JSON.stringify(s.inserted).includes(secret), false);
});

Deno.test("persistence: credentials load from the database and survive a restart", async () => {
  const first = fakeStore();
  const before = new Credentials(first.store);
  const { secret, credential } = await before.issue("judge4");

  const restarted = new Credentials(
    fakeStore([
      {
        id: credential.id,
        clientId: "judge4",
        label: null,
        createdAt: new Date(),
        revokedAt: null,
        secretHash: first.inserted[0].secretHash,
      },
    ]).store,
  );
  assertEquals((await restarted.authenticate(secret))?.clientId, "judge4");
});

Deno.test("persistence: a revoked credential stays revoked after reload", async () => {
  const hash = await hashSecret("s3cret");
  const creds = new Credentials(
    fakeStore([{
      id: 1,
      clientId: "dj1",
      label: null,
      createdAt: new Date(),
      revokedAt: new Date(),
      secretHash: hash,
    }]).store,
  );
  assertEquals(await creds.authenticate("s3cret"), undefined);
});

Deno.test("persistence: revoke is written to the database", async () => {
  const s = fakeStore();
  const creds = new Credentials(s.store);
  const { credential } = await creds.issue("judge2");
  await creds.revoke(credential.id);
  assertEquals(s.revoked, [credential.id]);
});

Deno.test("persistence: a failed load is retried, and does not authenticate anyone meanwhile", async () => {
  const hash = await hashSecret("abc");
  const s = fakeStore([{
    id: 1,
    clientId: "sb2",
    label: null,
    createdAt: new Date(),
    revokedAt: null,
    secretHash: hash,
  }]);
  s.failNext(1);
  const creds = new Credentials(s.store);
  await assertRejects(() => creds.authenticate("abc"), Error, "db down");
  assertEquals((await creds.authenticate("abc"))?.clientId, "sb2"); // second attempt loads
  assertEquals(s.loads(), 2);
  await creds.authenticate("abc");
  assertEquals(s.loads(), 2); // loaded once; cache serves the rest
});
