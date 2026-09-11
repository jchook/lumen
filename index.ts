import v3 from "./src/web3/index.html";
import v2 from "./src/web2/index.html";
import v1 from "./src/web/index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": v3,
    "/v2": v2,
    "/v1": v1,
    // The PWA files sit beside the bundle; the bundler doesn't know about them.
    "/manifest.webmanifest": () => new Response(Bun.file("src/web3/manifest.webmanifest"), { headers: { "content-type": "application/manifest+json" } }),
    "/sw.js": () => new Response(Bun.file("src/web3/sw.js"), { headers: { "content-type": "text/javascript" } }),
    "/icon-192.png": () => new Response(Bun.file("src/web3/icon-192.png")),
    "/icon-512.png": () => new Response(Bun.file("src/web3/icon-512.png")),
    "/apple-touch-icon.png": () => new Response(Bun.file("src/web3/apple-touch-icon.png")),
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`LUMEN → ${server.url}   (v2 at ${server.url}v2, v1 at ${server.url}v1)`);
