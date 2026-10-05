import { FomoSpot } from "@/components/fomo/FomoSpot";

export const metadata = {
  title: "Offline",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center lg:mx-auto lg:max-w-3xl lg:px-8 lg:py-12">
      <FomoSpot mood="gasp" pose="shrug" className="h-32 w-32" />
      <h1 className="text-headline-md text-on-surface">You&rsquo;re offline</h1>
      <p className="max-w-xs text-body-md text-on-surface-variant">
        Fomo can&rsquo;t reach the network right now. Reconnect to see
        what&rsquo;s on. Nothing you&rsquo;ve saved is lost.
      </p>
    </main>
  );
}
