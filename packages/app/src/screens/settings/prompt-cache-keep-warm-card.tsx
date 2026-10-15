import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

export function PromptCacheKeepWarmCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "promptCacheKeepWarm");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const { mutate, isPending, error } = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig({ keepPromptCacheWarm: next });
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
  });

  const handleValueChange = useCallback(
    (next: boolean) => {
      mutate(next);
    },
    [mutate],
  );

  if (!isConnected || !isSupported) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-prompt-cache-keep-warm-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.agents.keepPromptCacheWarm.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.agents.keepPromptCacheWarm.hint")}
          </Text>
          {isPending ? (
            <Text style={settingsStyles.rowHint} testID="host-page-prompt-cache-keep-warm-loading">
              {t("settings.host.agents.keepPromptCacheWarm.updating")}
            </Text>
          ) : null}
          {error ? (
            <Text style={settingsStyles.rowError} testID="host-page-prompt-cache-keep-warm-error">
              {error.message}
            </Text>
          ) : null}
        </View>
        <Switch
          value={config?.keepPromptCacheWarm === true}
          onValueChange={handleValueChange}
          disabled={isPending}
          accessibilityLabel={t("settings.host.agents.keepPromptCacheWarm.accessibilityLabel")}
          testID="host-page-prompt-cache-keep-warm-switch"
        />
      </View>
    </View>
  );
}
