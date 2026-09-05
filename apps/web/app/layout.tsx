import type { ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: "Deckastra",
  description: "Turn ideas, code, and data into presentations that move.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
