/**
 * Settings — two panes: a fixed navigation rail and one content pane for the
 * selected group (the approved settings redesign, 2026-09-20).
 *
 * The selected group is the `group` search param on this route, so any pane
 * is linkable and the browser back button moves between groups; the route
 * owns the param (`repos.settings.tsx`) and hands it in as a prop, defaulting
 * to the Account group.
 *
 * This file is a composition root: each group renders feature-owned cards
 * that keep their own files, state, and logic — only the containers and the
 * navigation moved. The 1000-line ceiling is enforced by
 * `pnpm check:file-sizes`, so new cards belong in their own section files,
 * not here.
 *
 * Deliberately NOT here, with the reason:
 *   voice, compute, hosted communities, mobile pairing, updates — each needs a
 *   native capability (local model files, mesh compute, a Tauri-side auth
 *   token, the pairing sidecar relay, the desktop updater).
 */

import { useCallback, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { LocalArchiveSettingsCard } from "@/features/local-archive";
import { ChannelTemplatesSettingsCard } from "@/features/channel-templates";
import { CommunityMembersCard } from "@/features/community-members/ui/CommunityMembersCard";
import { CustomEmojiSettingsCard } from "@/features/custom-emoji/ui/CustomEmojiSettingsCard";
import { IdentityArchiveCard } from "@/features/identity-archive";
import {
  KeyBackupCard,
  useOnboardingChecklist,
  WelcomeChecklistStrip,
} from "@/features/onboarding";
import type { ChecklistItem } from "@/features/onboarding/lib/onboardingChecklist.ts";
import { NotificationSettingsPanel } from "@/features/notifications/ui/NotificationSettingsContent";
import { PresenceSettingsCard } from "@/features/presence/ui/PresenceSettingsCard";
import { ProfileDialog } from "@/features/profile/ui/ProfileDialog";
import { ExperimentsCard } from "@/features/settings/ui/ExperimentsCard";
import { InvitesCard } from "@/features/settings/ui/InvitesCard";
import { KeyboardShortcutsCard } from "@/features/settings/ui/KeyboardShortcutsCard";
import { useFeatureEnabled } from "@/features/settings/useFeatureFlags";
import { VoiceSettingsCard } from "@/features/voice/ui/VoiceSettingsCard.tsx";
import { useOwnPubkey } from "@/shared/lib/useOwnPubkey";

import { AppearanceSection } from "./AppearanceSection";
import { isNativeIOS } from "@/shared/platform/native";
import { NativePushSettings } from "@/shared/platform/NativePush";
import { NativeDeviceSettings } from "@/shared/platform/NativeDeviceSettings";
import {
  DeviceSection,
  ForgetDeviceSection,
  PairDeviceSection,
} from "./settings/DeviceSection";
import {
  AgentsSection,
  FilesUrlSection,
  ProfileSection,
} from "./settings/MiscSections";
import { SettingsChipRow, SettingsNav } from "./settings/SettingsNav";
import {
  DEFAULT_SETTINGS_GROUP,
  resolveSettingsGroup,
  visibleSettingsGroups,
  type SettingsGroupId,
  type SettingsGroupMeta,
} from "./settings/settingsGroups";

/**
 * Where each setup-strip chip lands. The backup chip is the one that matters
 * — it is the route to the one step that protects the identity.
 */
function checklistTarget(item: ChecklistItem): SettingsGroupId | "channels" {
  switch (item.id) {
    case "profile":
      return "account";
    case "backup":
      return "security";
    case "notifications":
      return "notifications";
    case "theme":
      return "appearance";
    case "channel":
      return "channels";
  }
}

function PaneHeading({ group }: { group: SettingsGroupMeta }) {
  return (
    <div className="mb-4" data-testid="settings-pane-heading">
      <h1 className="text-lg font-semibold">{group.name}</h1>
      <p className="mt-0.5 text-sm text-muted-foreground">
        {group.description}
      </p>
    </div>
  );
}

export interface SettingsPageProps {
  /** The `group` search param; absent (or unknown) falls back to Account. */
  group?: string;
}

export function SettingsPage({ group }: SettingsPageProps) {
  const self = useOwnPubkey();
  const [profileOpen, setProfileOpen] = useState(false);
  const navigate = useNavigate({ from: "/repos/settings" });
  // Mirrors the desktop, where the channel-templates section carries
  // `featureGate: "channel-templates"`.
  const templatesEnabled = useFeatureEnabled("channel-templates");

  const nativeIOS = isNativeIOS();
  const groups = visibleSettingsGroups(nativeIOS);
  const parsed = resolveSettingsGroup(group);
  // A deep link to a group this device does not show (agents on iOS) falls
  // back to the default instead of an empty pane.
  const active = groups.some((candidate) => candidate.id === parsed)
    ? parsed
    : DEFAULT_SETTINGS_GROUP;
  const activeMeta = groups.find((candidate) => candidate.id === active);
  const checklist = useOnboardingChecklist();

  const selectGroup = useCallback(
    (id: SettingsGroupId) => {
      void navigate({
        to: "/repos/settings",
        // `account` is the default, so it stays paramless; any other group
        // is a shareable `?group=` link.
        search: id === "account" ? {} : { group: id },
      });
    },
    [navigate],
  );

  // The amber nav badge: the one critical setup item — the key backup — is
  // still outstanding. Derived from the checklist, which owns "is the backup
  // done"; this reads that state rather than re-deriving it from the backup
  // record.
  const backupPending = checklist.progress.hasOutstandingCritical;

  const onChecklistNavigate = useCallback(
    (item: ChecklistItem) => {
      const target = checklistTarget(item);
      if (target === "channels") {
        void navigate({ to: "/repos" });
        return;
      }
      selectGroup(target);
      // The profile chip already lands on this pane; raise the editor too so
      // the chip does the whole job.
      if (item.id === "profile") {
        setProfileOpen(true);
      }
    },
    [navigate, selectGroup],
  );

  return (
    <div
      className="flex h-dvh min-h-0 bg-background text-foreground"
      data-testid="settings-page"
    >
      {/* Navigation rail — the shell's sidebar chrome (sidebar tokens, so
          custom gradient themes tint it like every other rail). */}
      <nav
        aria-label="Settings"
        className="buzz-shell-navigation hidden w-62 shrink-0 flex-col border-r border-sidebar-border bg-sidebar pt-[max(0.875rem,env(safe-area-inset-top))] text-sidebar-foreground md:flex"
      >
        <div className="px-3 pb-2">
          <Button
            asChild
            className="min-h-11 min-w-11 md:min-h-8 md:min-w-0"
            data-testid="settings-back"
            size="sm"
            variant="ghost"
          >
            <Link to="/repos">← Back to Buzz</Link>
          </Button>
        </div>
        <SettingsNav
          active={active}
          attentionGroup={backupPending ? "security" : undefined}
          className="min-h-0 flex-1"
          groups={groups}
          onSelect={selectGroup}
        />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Narrow viewports: back header plus the nav as a chip row. */}
        <header
          className="flex shrink-0 items-center justify-between gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:hidden"
          data-testid="settings-header"
        >
          <Button
            asChild
            className="min-h-11 min-w-11 md:min-h-8 md:min-w-0"
            size="sm"
            variant="ghost"
          >
            <Link to="/repos">← Back</Link>
          </Button>
          <h1 className="text-lg font-semibold">Settings</h1>
        </header>
        <div className="shrink-0 md:hidden">
          <SettingsChipRow
            active={active}
            groups={groups}
            attentionGroup={backupPending ? "security" : undefined}
            onSelect={selectGroup}
          />
        </div>

        <main
          className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto"
          data-testid="settings-scroll"
        >
          <div className="mx-auto max-w-[45rem] px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-8">
            <div data-testid={`settings-pane-${active}`}>
              {activeMeta ? <PaneHeading group={activeMeta} /> : null}

              {active === "account" ? (
                <>
                  <div className="mb-4">
                    <WelcomeChecklistStrip
                      onNavigate={onChecklistNavigate}
                      state={checklist}
                    />
                  </div>
                  <div className="space-y-4">
                    <ProfileSection onOpen={() => setProfileOpen(true)} />
                    <PresenceSettingsCard />
                    <VoiceSettingsCard selfPubkey={self} />
                  </div>
                </>
              ) : null}

              {active === "notifications" ? (
                <div className="space-y-4">
                  {/*
                    Native iOS keeps its push-enrollment controls; the web
                    pane inlines the notification dialog's content — same
                    hooks, same controls, no dialog chrome. The permission
                    prompt still fires only from the switch's own change
                    event, never on mount.
                  */}
                  {nativeIOS ? (
                    <NativePushSettings />
                  ) : (
                    <NotificationSettingsPanel />
                  )}
                </div>
              ) : null}

              {active === "appearance" ? (
                <div className="space-y-4">
                  <AppearanceSection />
                </div>
              ) : null}

              {active === "keyboard" ? (
                <div className="space-y-4">
                  <KeyboardShortcutsCard />
                </div>
              ) : null}

              {active === "community" ? (
                <div className="space-y-4">
                  <CommunityMembersCard />
                  <CustomEmojiSettingsCard />
                  <InvitesCard />
                  {templatesEnabled ? <ChannelTemplatesSettingsCard /> : null}
                </div>
              ) : null}

              {active === "agents" ? (
                <div className="space-y-4">
                  <AgentsSection />
                </div>
              ) : null}

              {active === "data" ? (
                <div className="space-y-4">
                  <LocalArchiveSettingsCard />
                  <FilesUrlSection />
                </div>
              ) : null}

              {active === "security" ? (
                <div className="space-y-4">
                  {nativeIOS ? (
                    <NativeDeviceSettings />
                  ) : (
                    <>
                      <KeyBackupCard />
                      <DeviceSection />
                      <PairDeviceSection />
                    </>
                  )}
                  <ForgetDeviceSection />
                  <IdentityArchiveCard />
                </div>
              ) : null}

              {active === "advanced" ? (
                <div className="space-y-4">
                  <ExperimentsCard />
                </div>
              ) : null}
            </div>

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
        </main>
      </div>
    </div>
  );
}
