import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0B132B",
        slate: "#1C2541",
        mint: "#5BC0BE"
      }
    }
  },
  plugins: []
};

export default config;
