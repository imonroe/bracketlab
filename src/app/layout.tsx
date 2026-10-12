import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BracketLab",
  description: "Merge three bracketed RAW exposures into an editable HDR DNG.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
