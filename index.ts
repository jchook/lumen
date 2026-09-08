import v2 from "./src/web2/index.html";
import v1 from "./src/web/index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": v2,
    "/v1": v1,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`LUMEN → ${server.url}   (v1 at ${server.url}v1)`);
