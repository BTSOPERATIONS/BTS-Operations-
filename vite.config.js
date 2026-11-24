import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes the build work under https://USER.github.io/REPO/
export default defineConfig({
  plugins: [react()],
  base: "./",
});
