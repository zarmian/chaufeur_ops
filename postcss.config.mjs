/**
 * Tailwind 4 moved its PostCSS integration into its own package, and folded
 * vendor prefixing in — so `autoprefixer` is gone rather than missing.
 *
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
