import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OpsFlow", template: "%s · OpsFlow" },
  description: "Turn messy business requests into structured, actionable workflows.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f1b2d" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
