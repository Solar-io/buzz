/**
 * Settings — two panes: a fixed navigation rail and one content pane for the
 * selected group (the approved settings redesign, 2026-09-20).
 *
 * The selected group is the `group` search param on this route, so any pane
 * is linkable and the browser back button moves between groups; the route
 * owns the selectors (`repos.settings.tsx`); owners land on Agents, other
 * viewers land on Account. A phone starts at the settings root list.
 *
 * This file is a composition root: each group renders feature-owned cards
 * that keep their own files, state, and logic — only the containers and the
 * navigation moved. The 1000-line ceiling is enforced by
 * `pnpm check:file-sizes`, so new cards belong in their own section files,
 * not here.
 *
 * Deliberately NOT here, with the reason:
 *   compute, hosted communities, mobile pairing, updates — each needs a
 *   native capability (local model files, mesh compute, a Tauri-side auth
 *   token, the pairing sidecar relay, the desktop updater).
 */

import { useCallback, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/shared/ui/button";
import { usePhoneLayout } from "@/shared/layout/AppShell";
import {
  shellSidebarWidth,
  useShellSidebarWidthVar,
} from "@/shared/layout/shellCanvas";
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
import { AgentVoicesCard } from "@/features/voice/ui/AgentVoicesCard.tsx";
import { VoiceSettingsCard } from "@/features/voice/ui/VoiceSettingsCard.tsx";
import { VoiceLibraryCard } from "@/features/voice/ui/VoiceLibraryCard.tsx";
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
import { FilesUrlSection, ProfileSection } from "./settings/MiscSections";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import { useDesktopPresence } from "@/features/agents/useDesktopPresence";
import { ownsSettingsAgents } from "@/features/agents/lib/desktopConnection";
import { DesktopConnectionFooter } from "@/features/agents/settings/DesktopConnectionFooter";
import { AgentManagementSection } from "@/features/agents/settings/AgentManagementSection";
import { AgentScreen } from "@/features/agents/settings/agent-screen/AgentScreen";
import { ClaudePoolsSection } from "./settings/ClaudePoolsSection";
import { FilesSitesSection } from "@/features/webPanels/ui/FilesSitesSection";
import { SettingsNav } from "./settings/SettingsNav";
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
  agent?: string;
  tab?: string;
  definition?: string;
}

export function SettingsPage({
  group,
  agent,
  tab,
  definition,
}: SettingsPageProps) {
  const self = useOwnPubkey();
  const [profileOpen, setProfileOpen] = useState(false);
  const navigate = useNavigate({ from: "/repos/settings" });
  // Mirrors the desktop, where the channel-templates section carries
  // `featureGate: "channel-templates"`.
  const templatesEnabled = useFeatureEnabled("channel-templates");

  const nativeIOS = isNativeIOS();
  const phone = usePhoneLayout();
  const registry = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  const ownsAgents = ownsSettingsAgents(catalogs, registry);
  const showPhoneRoot = phone && !group && !agent;
  const selectAgent = (pubkey: string) => {
    void navigate({
      to: "/repos/settings",
      search: { group: "agents", agent: pubkey },
    });
  };
  const groups = visibleSettingsGroups(phone);
  const parsed = resolveSettingsGroup(agent ? "agents" : group, { ownsAgents });
  // Keyboard is omitted on phones; its deep link falls back to Account.
  const active = groups.some((candidate) => candidate.id === parsed)
    ? parsed
    : DEFAULT_SETTINGS_GROUP;
  const activeMeta = groups.find((candidate) => candidate.id === active);
  const monitorDesktop = ["agents", "accounts", "library"].includes(active);
  const presence = useDesktopPresence(monitorDesktop ? catalogs : []);
  const checklist = useOnboardingChecklist();

  const selectGroup = useCallback(
    (id: SettingsGroupId) => {
      void navigate({
        to: "/repos/settings",
        // Keep Account explicit: an owner has a different default landing.
        search: { group: id },
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

  // Canvas below the shell mirrors the rail/pane split (see shellCanvas.ts).
  // 15.5rem = the rail's `w-62`; the rail is hidden below md.
  useShellSidebarWidthVar(
    shellSidebarWidth({ chromeless: false, phone, width: "15.5rem" }),
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
          <h1 className="px-2 pt-2 text-xl font-semibold">Settings</h1>
        </div>
        <SettingsNav
          active={active}
          attentionGroup={backupPending ? "security" : undefined}
          className="min-h-0 flex-1"
          groups={groups}
          onSelect={selectGroup}
          agents={registry}
          onSelectAgent={selectAgent}
          footer={
            <DesktopConnectionFooter
              catalogs={catalogs}
              presence={monitorDesktop ? presence.byMachine : undefined}
            />
          }
        />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Narrow viewports: back header plus the nav as a chip row. */}
        {!agent && (
          <header
            className="flex shrink-0 items-center justify-between gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:hidden"
            data-testid="settings-header"
          >
            <Button
              className="min-h-11 min-w-11 md:min-h-8 md:min-w-0"
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigate(
                  showPhoneRoot
                    ? { to: "/repos" }
                    : { to: "/repos/settings", search: {} },
                );
              }}
            >
              ← {showPhoneRoot ? "Back" : "Settings"}
            </Button>
            <h1 className="text-lg font-semibold">Settings</h1>
          </header>
        )}
        {showPhoneRoot ? (
          <SettingsNav
            active={active}
            groups={groups}
            onSelect={selectGroup}
            agents={registry}
            onSelectAgent={selectAgent}
            phoneRoot
            attentionGroup={backupPending ? "security" : undefined}
            className="min-h-0 flex-1 px-4"
            footer={
              <DesktopConnectionFooter
                catalogs={catalogs}
                presence={monitorDesktop ? presence.byMachine : undefined}
              />
            }
          />
        ) : null}

        <main
          className={
            showPhoneRoot
              ? "hidden"
              : "buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto"
          }
          data-testid="settings-scroll"
        >
          <div
            className={`mx-auto ${active === "agents" && !agent ? "max-w-none" : active === "agents" || active === "library" ? "max-w-6xl" : "max-w-[45rem]"} px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-8`}
          >
            <div data-testid={`settings-pane-${active}`}>
              {activeMeta && !agent ? <PaneHeading group={activeMeta} /> : null}

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
                  </div>
                </>
              ) : null}

              {active === "voice" ? (
                <div className="space-y-4">
                  <VoiceSettingsCard selfPubkey={self} />
                  <AgentVoicesCard />
                  <VoiceLibraryCard />
                </div>
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
                </div>
              ) : null}

              {active === "channels" ? (
                templatesEnabled ? (
                  <ChannelTemplatesSettingsCard />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Channel templates are turned off. Enable them in Advanced.
                  </p>
                )
              ) : null}
              {active === "agents" ? (
                agent ? (
                  self ? (
                    <AgentScreen
                      key={agent}
                      agentPubkey={agent}
                      tab={tab}
                      onBack={() => selectGroup("agents")}
                      onSelect={selectAgent}
                      onTab={(nextTab) =>
                        void navigate({
                          to: "/repos/settings",
                          search: { group: "agents", agent, tab: nextTab },
                        })
                      }
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Unlock your key to manage this agent.
                    </p>
                  )
                ) : (
                  <AgentManagementSection embedded />
                )
              ) : null}
              {active === "accounts" ? <ClaudePoolsSection /> : null}
              {active === "library" ? (
                <AgentManagementSection
                  key={tab ?? "definitions"}
                  embedded
                  section="library"
                  tab={tab}
                  definition={definition}
                />
              ) : null}

              {active === "data" ? (
                <div className="space-y-4">
                  <LocalArchiveSettingsCard />
                  <FilesUrlSection />
                  <FilesSitesSection />
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
                  <p className="text-sm text-muted-foreground">
                    Keep awake, Git Bash and build options live in Buzz Desktop.
                  </p>
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
