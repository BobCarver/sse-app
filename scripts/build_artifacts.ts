// Simple artifact bundler for frontend files.
// Bundles app/src/frontend/* -> public/*.js

const entries = [
  { src: "app/frontend-src/dj.ts", out: "public/dj.js" },
  { src: "app/frontend-src/jd.ts", out: "public/jd.js" },
  { src: "app/frontend-src/sb.ts", out: "public/sb.js" },
  { src: "app/frontend-src/sseClient.ts", out: "public/sseClient.js" },
];

await Deno.mkdir("public", { recursive: true });
for (const e of entries) {
  console.log(`Bundling ${e.src} -> ${e.out}`);
  const result = await Deno.emit(e.src, { bundle: "module" });
  const js = result.files["deno:///bundle.js"];
  if (!js) throw new Error(`bundle missing for ${e.src}`);
  await Deno.writeTextFile(e.out, js);
}
console.log("Artifacts built to ./public/");
