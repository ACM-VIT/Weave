/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        darkBg: '#0B0F0C',
        accentPrimary: '#8EFF7A',
        accentSecondary: '#66D95B',
        glowColor: 'rgba(142,255,122,0.35)',
      },
      fontFamily: {
        sans: ['NataSans-Regular', 'System'],
        medium: ['NataSans-Medium', 'System'],
        semibold: ['NataSans-SemiBold', 'System'],
        bold: ['NataSans-Bold', 'System'],
      },
    },
  },
  plugins: [],
};