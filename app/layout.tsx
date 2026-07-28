import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://raft-agent-workspace.sugary-brush-1278.chatgpt.site"),
  title: "Flock Works — Work with your agents",
  description: "A shared collaboration space for people and long-running agents.",
  openGraph: {
    title: "Flock Works — Humans + agents, in sync",
    description: "A shared collaboration space for people and long-running agents.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Flock multi-agent collaboration workspace" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Flock Works — Humans + agents, in sync",
    description: "A shared collaboration space for people and long-running agents.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/flock.png",
    shortcut: "/flock.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
