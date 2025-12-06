import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(__dirname, "src/index.ts"),
    },
  },
});
