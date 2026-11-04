/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'sans-serif'],
        hand: ['Caveat', 'cursive'],
      },
      colors: {
        ink: {
          900: '#04070f',
          800: '#060c18',
          700: '#0a1424',
        },
      },
    },
  },
  plugins: [],
}
