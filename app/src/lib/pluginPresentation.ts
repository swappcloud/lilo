import type { PluginManifest, PluginPresentation } from "../types";

/** Plugin-owned labels, with a fallback for older and third-party manifests. */
export function pluginPresentation(
  metadata: Pick<PluginManifest, "name" | "description" | "localized">,
  locale: string,
): PluginPresentation {
  const entries = Object.entries(metadata.localized ?? {});
  const tag = locale.toLowerCase();
  const localized = entries.find(([key]) => key.toLowerCase() === tag)?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === tag.split("-")[0])?.[1];
  return {
    name: localized?.name.trim() || metadata.name,
    description: localized?.description.trim() || metadata.description || "",
  };
}
