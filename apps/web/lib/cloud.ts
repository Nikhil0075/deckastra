import publicAuth from "../../../infrastructure/deployment/public-auth.json";

/**
 * Which hosted Deckastra this build talks to, if any.
 *
 * `NEXT_PUBLIC_DECKASTRA_CLOUD` names an entry in
 * `infrastructure/deployment/public-auth.json` (`deckastra` for development,
 * `deckastra-prod` for production). That file is the one description of the
 * public sign-in configuration; the backend's deployment reads it too, so the
 * web app copies nothing out of it.
 *
 * Unset is a checkout talking to a local API with the development sign-in,
 * which is what `npm run dev:web` has always done.
 *
 * The values are public by design: a Firebase browser key and OAuth client IDs
 * identify the application, they do not authorise anyone.
 */
export interface CloudConfig {
  name: string;
  projectId: string;
  authDomain: string;
  apiKey: string;
  apiUrl: string;
}

// Inlined at build time, so this stays a literal property access.
const SELECTED = process.env.NEXT_PUBLIC_DECKASTRA_CLOUD;

export function cloudConfig(name: string | undefined = SELECTED): CloudConfig | null {
  if (!name) return null;
  const entry = (publicAuth as Record<string, Omit<CloudConfig, "name"> | undefined>)[name];
  if (!entry) {
    // A typo here would otherwise fall back to the development sign-in against
    // whatever API is configured, which is a different product from the one
    // the person asked for. Fail where it can be seen.
    throw new Error(`NEXT_PUBLIC_DECKASTRA_CLOUD names "${name}", which public-auth.json does not describe.`);
  }
  return { name, ...entry };
}
