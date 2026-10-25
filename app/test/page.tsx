import type { Metadata } from "next";
import ScanApp from "@/components/test/ScanApp";

export const metadata: Metadata = {
  title: "cthru · scan",
  description: "Slide your camera past a narrow gap and stitch together a wide picture of what's behind it.",
};

export default function TestPage() {
  return (
    <main className="flex flex-1 flex-col">
      <ScanApp />
    </main>
  );
}
