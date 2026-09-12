import type { ReactNode } from "react";

import "@deckastra/editor-ui/styles.css";

import { Providers } from "./providers";

export const metadata = {
  title: "Deckastra",
  description: "Turn ideas, code, and data into presentations that move.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
