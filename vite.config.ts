import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://localhost:8788",
      "/events": "http://localhost:8788"
    }
  }
});
