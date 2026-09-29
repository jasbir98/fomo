"use client";

import { useSyncExternalStore } from "react";
import { getInstallState, SERVER_INSTALL_STATE, subscribeInstall, type InstallState } from "./install-prompt";

/** Live install state. Server and hydration pass see `{ platform: null, ... }`, then the real client values. */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeInstall, getInstallState, () => SERVER_INSTALL_STATE);
}
