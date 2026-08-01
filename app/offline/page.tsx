export const metadata = {
  title: "Offline — Roameo",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        className="material-symbols-outlined text-secondary-container"
        style={{ fontSize: "56px" }}
        aria-hidden
      >
        wifi_off
      </span>
      <h1 className="text-headline-md text-on-surface">You&rsquo;re offline</h1>
      <p className="max-w-xs text-body-md text-on-surface-variant">
        Roameo can&rsquo;t reach the network right now. Check your connection —
        your trip is saved and will be here when you&rsquo;re back.
      </p>
    </main>
  );
}
