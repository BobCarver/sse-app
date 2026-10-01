import { assertEquals } from "@std/assert";
import { sha256Bytes, sha256Hex } from "../../src/sha256.ts";

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("sha256: known vectors (pure JS)", () => {
  assertEquals(
    hex(sha256Bytes(enc(""))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    hex(sha256Bytes(enc("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    hex(
      sha256Bytes(
        enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      ),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

Deno.test("sha256: pure JS agrees with the platform for every length around the padding boundaries", async () => {
  // 55/56 and 63/64 are where the length field no longer fits in the block.
  const lengths = [
    ...Array.from({ length: 140 }, (_, i) => i),
    1000,
    4096,
    100_000,
  ];
  for (const n of lengths) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    const expected = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    );
    assertEquals(hex(sha256Bytes(data)), expected, `length ${n}`);
  }
});

Deno.test("sha256Hex: same answer with and without crypto.subtle", async () => {
  const data = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
  const withSubtle = await sha256Hex(data);
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  try {
    // An insecure browser origin has no crypto.subtle.
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
    });
    assertEquals(await sha256Hex(data), withSubtle);
    assertEquals(await sha256Hex(data.buffer), withSubtle); // ArrayBuffer too
  } finally {
    Object.defineProperty(globalThis, "crypto", original);
  }
});
