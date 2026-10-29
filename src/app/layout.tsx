import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neoflix — Interactive Story Maps",
  description:
    "Interactive, sourced news stories on a living 3D globe. Civilization-scale strategy game aesthetics, Pandemic-board-game tension, unopinionated facts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  );
}
