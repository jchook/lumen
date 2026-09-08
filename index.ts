import v3 from "./src/web3/index.html";
import v2 from "./src/web2/index.html";
import v1 from "./src/web/index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": v3,
    "/v2": v2,
    "/v1": v1,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`LUMEN → ${server.url}   (v2 at ${server.url}v2, v1 at ${server.url}v1)`);
