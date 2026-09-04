/**
 * Settings.
 *
 * The desktop splits its settings across a sidebar of sixteen sections; this
 * is one scrolling page, grouped the same way, because the web client has far
 * fewer sections that a browser can serve at all — a nav rail with four live
 * entries and twelve dead ones would be worse than a list.
 *
 * Sections live in their own files (`./settings/*`, and the owning feature for
 * anything with logic behind it) so this file stays a composition root. That
 * is not tidiness for its own sake: the 1000-line ceiling is enforced by
 * `pnpm check:file-sizes`, and this page is the one that grows.
 *
 * Deliberately NOT here, with the reason:
 *   voice, compute, hosted communities, mobile pairing, updates — each needs a
 *   native capability (local model files, mesh compute, a Tauri-side auth
 *   token, the pairing sidecar relay, the desktop updater).
 */

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { LocalArchiveSettingsCard } from "@/features/local-archive";
import { ChannelTemplatesSettingsCard } from "@/features/channel-templates";
import { IdentityArchiveCard } from "@/features/identity-archive";
import { KeyBackupCard, WelcomeChecklist } from "@/features/onboarding";
import { ProfileDialog } from "@/features/profile/ui/ProfileDialog";
import { ExperimentsCard } from "@/features/settings/ui/ExperimentsCard";
import { InvitesCard } from "@/features/settings/ui/InvitesCard";
import { KeyboardShortcutsCard } from "@/features/settings/ui/KeyboardShortcutsCard";
import { useFeatureEnabled } from "@/features/settings/useFeatureFlags";
import { ownPubkey } from "@/shared/lib/nostr-signer";

import { AppearanceSection } from "./AppearanceSection";
import {
  DeviceSection,
  ForgetDeviceSection,
  PairDeviceSection,
} from "./settings/DeviceSection";
import {
  AgentsSection,
  FilesUrlSection,
  NotificationsSection,
  ProfileSection,
} from "./settings/MiscSections";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
      {children}
    </h2>
  );
}

export function SettingsPage() {
  const [self, setSelf] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  // Mirrors the desktop, where the channel-templates section carries
  // `featureGate: "channel-templates"`.
  const templatesEnabled = useFeatureEnabled("channel-templates");

  useEffect(() => {
    void ownPubkey().then(setSelf);
  }, []);

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/repos">Back to channels</Link>
        </Button>
      </div>

      <WelcomeChecklist />

      <SectionHeading>You</SectionHeading>
      <ProfileSection onOpen={() => setProfileOpen(true)} />
      <NotificationsSection />
      <AppearanceSection />
      <KeyboardShortcutsCard />

      <SectionHeading>Community</SectionHeading>
      <InvitesCard />
      <IdentityArchiveCard />
      <AgentsSection />
      {templatesEnabled ? <ChannelTemplatesSettingsCard /> : null}

      <SectionHeading>Data</SectionHeading>
      <LocalArchiveSettingsCard />
      <FilesUrlSection />

      <SectionHeading>Identity and this device</SectionHeading>
      <KeyBackupCard />
      <DeviceSection />
      <PairDeviceSection />
      <ForgetDeviceSection />

      <SectionHeading>Advanced</SectionHeading>
      <ExperimentsCard />

      {self ? (
        <ProfileDialog
          fallbackLabel="You"
          onOpenChange={setProfileOpen}
          open={profileOpen}
          pubkey={self}
          selfPubkey={self}
          startInEdit
        />
      ) : null}
    </div>
  );
}
