// Bundles browser entry points -> public/*.js (served at /js/*.js).
// Usage: deno task build

const entries = [
  { src: "app/frontend-src/main-dj.ts", out: "public/dj.js" },
  { src: "app/frontend-src/main-jd.ts", out: "public/jd.js" },
  { src: "app/frontend-src/main-sb.ts", out: "public/sb.js" },
  { src: "app/frontend-src/main-admin.ts", out: "public/admin.js" },
];

await Deno.mkdir("public", { recursive: true });
for (const { src, out } of entries) {
  console.log(`Bundling ${src} -> ${out}`);
  const { success } = await new Deno.Command(Deno.execPath(), {
    args: ["bundle", "--platform=browser", "--output", out, src],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!success) throw new Error(`bundle failed for ${src}`);
}
console.log("Artifacts built to ./public/");
