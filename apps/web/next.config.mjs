/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship TypeScript source rather than a build step —
  // one less thing to keep in sync while the schema is still moving. Next
  // compiles them as part of the app.
  transpilePackages: ["@deckastra/renderer", "@deckastra/presentation-schema"],
  reactStrictMode: true,
};

export default nextConfig;
