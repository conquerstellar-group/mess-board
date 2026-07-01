const PORT = 3000;
const PUBLIC_DIR = import.meta.dir + "/public";

// MIME types for static files
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    // Default to index.html
    if (path === "/") path = "/index.html";

    const filePath = PUBLIC_DIR + path;
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      // Fallback to index.html for SPA
      const fallback = Bun.file(PUBLIC_DIR + "/index.html");
      if (await fallback.exists()) {
        return new Response(fallback, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    const ext = path.substring(path.lastIndexOf("."));
    const contentType = MIME[ext] ?? "application/octet-stream";

    return new Response(file, {
      headers: { "Content-Type": contentType },
    });
  },
});

console.log(`\n🌐 Frontend: http://localhost:${PORT}`);
console.log(`📁 Serving: ${PUBLIC_DIR}\n`);
