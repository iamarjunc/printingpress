import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "production-security-policy",
      apply: "build",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content:
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src https://api.github.com; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'",
          },
          injectTo: "head-prepend",
        },
      ],
    },
  ],
  base: "./",
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/.private-data/**",
        "**/*.private.zip",
      ],
    },
  },
  build: { sourcemap: false },
});
