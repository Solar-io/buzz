/**
 * Experiments — the web counterpart of the desktop's `ExperimentalFeaturesCard`.
 *
 * The manifest is preview-only, so every row here gates something real. If
 * this card ever lists a feature whose switch changes nothing, delete the row
 * rather than leaving it: a dead toggle teaches people the settings lie.
 */

import { Switch } from "@/shared/ui/switch";

import { WEB_FEATURES } from "../lib/featureFlags.ts";
import { useFeatureToggle } from "../useFeatureFlags";

function FeatureRow({
  description,
  id,
  name,
}: {
  description: string;
  id: string;
  name: string;
}) {
  const [enabled, toggle] = useFeatureToggle(id);
  const switchId = `feature-toggle-${id}`;
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" id={`${switchId}-label`}>
          {name}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-labelledby={`${switchId}-label`}
        checked={enabled}
        data-testid={switchId}
        onCheckedChange={toggle}
      />
    </div>
  );
}

export function ExperimentsCard() {
  return (
    <section
      className="space-y-1 rounded-lg border border-border bg-card p-4"
      data-testid="experiments-card"
    >
      <h2 className="font-medium">Experiments</h2>
      <p className="text-sm text-muted-foreground">
        Features that work but are still being refined. Turn one on to try it
        early; the choice is remembered in this browser.
      </p>
      <div className="divide-y divide-border">
        {WEB_FEATURES.map((feature) => (
          <FeatureRow
            description={feature.description}
            id={feature.id}
            key={feature.id}
            name={feature.name}
          />
        ))}
      </div>
    </section>
  );
}
