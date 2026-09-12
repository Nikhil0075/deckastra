/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship TypeScript source rather than a build step —
  // one less thing to keep in sync while the schema is still moving. Next
  // compiles them as part of the app.
  //
  // Every workspace package the app imports has to be listed. Four of them were
  // missing and worked only because nothing in them needed transpiling yet; the
  // first `.tsx` or modern syntax in one would have failed the build with an
  // error pointing at node_modules.
  // Transitive imports count: `@deckastra/editor-ui` pulls in the editor,
  // transactions, presentation-core and the animation engine, and Next has to be
  // told about each of them by name.
  transpilePackages: [
    "@deckastra/animation-engine",
    "@deckastra/editor",
    "@deckastra/editor-ui",
    "@deckastra/presentation-core",
    "@deckastra/presentation-schema",
    "@deckastra/renderer",
    "@deckastra/transactions",
    "@deckastra/workspace-client",
    "@deckastra/workspace-contracts",
  ],
  reactStrictMode: true,
};

export default nextConfig;
