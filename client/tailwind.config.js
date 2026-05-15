/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: "#6366F1",
          success: "#22C55E",
          warning: "#F59E0B",
          danger: "#EF4444",
          dark: "#0B0F19",
          card: "#111827",
        },
      },
    },
  },
  plugins: [],
};