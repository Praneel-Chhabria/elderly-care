import type { Metadata } from "next";
import NavBar from "@/components/NavBar";
import { Atkinson_Hyperlegible, Fraunces } from "next/font/google";
import "./globals.css";

const atkinson = Atkinson_Hyperlegible({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-atkinson",
});
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces" });

export const metadata: Metadata = {
  title: "Elderly Care",
  description: "Medicine reminders and check-ins for the people you look after",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${atkinson.variable} ${fraunces.variable}`}>
      <body className="font-sans antialiased">
        <div className="mx-auto max-w-5xl px-5 pb-16 pt-6 sm:px-8">
          <NavBar />
          {children}
        </div>
      </body>
    </html>
  );
}
