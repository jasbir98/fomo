"use client";

import { useEffect } from "react";
import { initInstallCapture } from "@/lib/pwa/install-prompt";

/**
 * Renders nothing. Importing the module attaches the `beforeinstallprompt`
 * listener as this chunk loads (well before AppShell mounts); the effect is a
 * belt-and-braces call in case the module was tree-shaken or evaluated on the
 * server first. Lives here so the server-component root layout can mount it.
 */
export function InstallCapture() {
  useEffect(() => {
    initInstallCapture();
  }, []);
  return null;
}

export default InstallCapture;
