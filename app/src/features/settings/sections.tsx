/**
 * The settings navigation: one entry per page.
 *
 * Kept as data so the shell does not have to know anything about the pages,
 * and adding a page is one line here plus the component itself. Pages a plugin
 * brings are appended from the installed plugins, so a plugin with settings
 * gets its own entry instead of living inside the Plugins list.
 */

import type { ComponentType } from "react";

import type { TranslationKey } from "../../i18n";
import type { PluginView } from "../../types";
import { AccountSection } from "./AccountSection";
import { AppearanceSection } from "./AppearanceSection";
import { CommandsSection } from "./CommandsSection";
import { DevicesSection } from "./DevicesSection";
import { GatewaySection } from "./GatewaySection";
import { MediaSection } from "./MediaSection";
import { PluginPage, pluginPageId } from "./PluginPage";
import { pluginPresentation } from "../../lib/pluginPresentation";
import { PluginsSection } from "./PluginsSection";
import { ProcessSection } from "./ProcessSection";
import { ProviderSection } from "./ProviderSection";
import { StorageSection } from "./StorageSection";
import { ToolsSection } from "./ToolsSection";
import { WakeWordSection } from "./WakeWordSection";
import { UpdateSection } from "./UpdateSection";
import { ConversationSection } from "./ConversationSection";
import { DiagnosticsSection } from "./DiagnosticsSection";

export type SettingsGroup = "general" | "voice" | "tools" | "plugins" | "application" | "advanced";

export const SETTINGS_GROUPS: readonly { id: SettingsGroup; labelKey: TranslationKey }[] = [
  { id: "general", labelKey: "settings.group.general" },
  { id: "voice", labelKey: "settings.group.voice" },
  { id: "tools", labelKey: "settings.group.tools" },
  { id: "plugins", labelKey: "settings.group.plugins" },
  { id: "application", labelKey: "settings.group.application" },
  { id: "advanced", labelKey: "settings.group.advanced" },
];

export interface SettingsPageProps {
  plugin?: PluginView;
  /** Move to another page by id; plugin links use it to open their page. */
  onNavigate: (id: string) => void;
}

export interface SettingsPage {
  plugin?: PluginView;
  id: string;
  group: SettingsGroup;
  /** Shown in the sidebar and as the page heading. */
  labelKey?: TranslationKey;
  /** Overrides `labelKey`; plugin pages are named by the plugin. */
  label?: string;
  Component: ComponentType<SettingsPageProps>;
  /**
   * Set when the page owns something that can need authorisation. The shell
   * turns this into a badge, so the user is told *where* to look instead of
   * hunting through every page.
   */
  alert?: "mic" | "wake";
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: "account", group: "general", labelKey: "account.title", Component: AccountSection },
  { id: "appearance", group: "general", labelKey: "appearance.title", Component: AppearanceSection },
  { id: "provider", group: "voice", labelKey: "provider.title", Component: ProviderSection },
  { id: "conversation", group: "voice", labelKey: "conversation.title", Component: ConversationSection },
  { id: "devices", group: "voice", labelKey: "devices.title", Component: DevicesSection, alert: "mic" },
  { id: "wake", group: "voice", labelKey: "wake.title", Component: WakeWordSection, alert: "wake" },
  { id: "language", group: "voice", labelKey: "language.title", Component: CommandsSection },
  { id: "media", group: "tools", labelKey: "media.title", Component: MediaSection },
  { id: "tools", group: "tools", labelKey: "tools.title", Component: ToolsSection },
  { id: "plugins", group: "plugins", labelKey: "plugins.title", Component: PluginsSection },
  { id: "updates", group: "application", labelKey: "update.title", Component: UpdateSection },
  { id: "storage", group: "application", labelKey: "storage.title", Component: StorageSection },
  { id: "process", group: "application", labelKey: "process.title", Component: ProcessSection },
  { id: "diagnostics", group: "application", labelKey: "diagnostics.title", Component: DiagnosticsSection },
  { id: "gateway", group: "advanced", labelKey: "gateway.title", Component: GatewaySection },
];

/**
 * The pages active plugins bring: their settings, actions and status, out of
 * the Plugins list and into the navigation, where every other page lives. A
 * plugin with nothing to show gets no page.
 */
function PluginSettingsPage({ plugin }: SettingsPageProps) {
  return plugin ? <PluginPage plugin={plugin} /> : null;
}

export function pluginPages(plugins: PluginView[], locale = "en"): SettingsPage[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.enabled &&
        plugin.loaded &&
        (plugin.ui.settings.length > 0 ||
          plugin.ui.status.length > 0 ||
          plugin.ui.actions.length > 0 ||
        Boolean(plugin.ui.list) || Boolean(plugin.ui.lists?.length) || Boolean(plugin.ui.cards?.length) ||
        Boolean(plugin.ui.progress?.length) || Boolean(plugin.ui.forms?.length)),
    )
    .map((plugin) => ({
      id: pluginPageId(plugin.manifest.id),
      group: "plugins" as const,
      label: pluginPresentation(plugin.manifest, locale).name,
      Component: PluginSettingsPage,
      plugin,
    }));
}
