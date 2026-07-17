/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#FBFBFD",
        ink: "#1D1D1F",
        "ink-soft": "#6E6E73",
        hairline: "#D2D2D7",
        accent: "#0071E3",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          '"SF Mono"',
          '"SFMono-Regular"',
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      borderRadius: {
        apple: "28px",
      },
      boxShadow: {
        apple: "0 1px 2px rgba(0,0,0,0.04), 0 20px 40px -20px rgba(0,0,0,0.15)",
      },
      keyframes: {
        "pulse-live": {
          "0%, 100%": { opacity: 1, transform: "scale(1)" },
          "50%": { opacity: 0.35, transform: "scale(0.8)" },
        },
        "rise-in": {
          "0%": { opacity: 0, transform: "translateY(10px)" },
          "100%": { opacity: 1, transform: "translateY(0)" },
        },
      },
      animation: {
        "pulse-live": "pulse-live 2s ease-in-out infinite",
        "rise-in": "rise-in 0.7s cubic-bezier(0.16,1,0.3,1) both",
      },
    },
  },
  plugins: [],
};
