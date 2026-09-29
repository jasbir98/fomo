"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BottomSheet, Button, Icon } from "@/components/ui";
import { promptInstall } from "@/lib/pwa/install-prompt";
import { useInstallState } from "@/lib/pwa/useInstallState";
import { track } from "@/lib/analytics/track";

export interface InstallSheetProps {
  open: boolean;
  onClose: () => void;
  /** Where it was opened from, for analytics ("hint", "header", "profile"). */
  source?: string;
}

interface Step {
  icon: string;
  text: ReactNode;
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((step, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container/10 text-primary">
            <Icon name={step.icon} size={22} />
          </span>
          <span className="text-body-md text-on-surface">{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

function CopyLinkButton() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (some in-app browsers): the visible URL is still there to long-press.
    }
  }

  return (
    <Button variant="outline" fullWidth leadingIcon={copied ? "check" : "content_copy"} onClick={() => void copy()}>
      {copied ? "Link copied" : "Copy link"}
    </Button>
  );
}

/**
 * "How to add Fomo to your phone" sheet, one body per platform (see
 * lib/pwa/install-prompt.ts for how the platform is detected). Only Android /
 * desktop Chrome can install in one tap, and only once the browser has handed
 * over its prompt; everywhere else it's a short set of steps.
 */
export function InstallSheet({ open, onClose, source }: InstallSheetProps) {
  const { platform, canPrompt, installed } = useInstallState();

  useEffect(() => {
    if (open) track("install_sheet_opened", { platform: platform ?? "unknown", source: source ?? "unknown" });
    // Only when it opens; a platform resolving later shouldn't re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleInstall() {
    const outcome = await promptInstall();
    if (outcome === "accepted") onClose();
  }

  let body: ReactNode;
  if (installed) {
    body = <p className="text-body-md text-on-surface-variant">Fomo is already on your home screen. Nice one.</p>;
  } else if (canPrompt) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-body-md text-on-surface-variant">
          Add Fomo to your home screen. It opens instantly, like any other app.
        </p>
        <Button variant="orange" fullWidth leadingIcon="install_mobile" onClick={() => void handleInstall()}>
          Install Fomo
        </Button>
      </div>
    );
  } else if (platform === "ios") {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-body-md text-on-surface-variant">Four quick taps in Safari:</p>
        <Steps
          steps={[
            { icon: "ios_share", text: <>Tap <strong>Share</strong> in the Safari toolbar</> },
            { icon: "swipe_vertical", text: "Scroll down the list" },
            { icon: "add_box", text: <>Tap <strong>Add to Home Screen</strong></> },
            { icon: "check_circle", text: <>Tap <strong>Add</strong> in the top corner</> },
          ]}
        />
      </div>
    );
  } else if (platform === "ios-other-browser") {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-body-md text-on-surface-variant">
          On iPhone and iPad, only Safari can add Fomo to your home screen. Open{" "}
          <strong className="text-on-surface">askfomo.com</strong> in Safari to install.
        </p>
        <CopyLinkButton />
      </div>
    );
  } else if (platform === "in-app") {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-body-md text-on-surface-variant">
          You&rsquo;re in an app&rsquo;s built-in browser, which can&rsquo;t install Fomo. Open it in your own browser
          first.
        </p>
        <Steps
          steps={[
            { icon: "more_horiz", text: <>Tap the <strong>&bull;&bull;&bull;</strong> menu</> },
            { icon: "open_in_browser", text: <>Tap <strong>Open in browser</strong></> },
          ]}
        />
        <CopyLinkButton />
      </div>
    );
  } else if (platform === "android") {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-body-md text-on-surface-variant">Three quick taps in Chrome:</p>
        <Steps
          steps={[
            { icon: "more_vert", text: <>Tap the <strong>&#8942;</strong> menu in the corner</> },
            {
              icon: "add_to_home_screen",
              text: (
                <>
                  Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>
                </>
              ),
            },
            { icon: "check_circle", text: <>Tap <strong>Install</strong></> },
          ]}
        />
      </div>
    );
  } else {
    body = (
      <p className="text-body-md text-on-surface-variant">
        Fomo is made for your phone. Open <strong className="text-on-surface">askfomo.com</strong> there to add it to
        your home screen.
      </p>
    );
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Get Fomo on your phone">
      {body}
    </BottomSheet>
  );
}

export default InstallSheet;
