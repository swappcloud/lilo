import type { CSSProperties } from "react";

import {
  ACCENTS,
  VIZ_OPTIONS,
  type AccentColors,
  type AccentKey,
  type PaletteKey,
  type ThemeMode,
  type VizMode,
} from "../../store/preferencesStore";
import { useDraftPreference, useSettingsDraft } from "../../store/settingsDraft";
import { useShellStyle } from "../../app/shellStyle";
import { useTranslation, type TranslationKey } from "../../i18n";
import { isTauri } from "../../lib/gateway";
import { hostPort } from "../../lib/hostPort";
import { RangeSlider, SegmentedControl, Switch } from "../../shared/ui/controls";
import { Logo } from "../../shared/ui/Logo";
import { Section } from "../../shared/ui/primitives";

const PALETTE_KEYS = Object.keys(ACCENTS) as PaletteKey[];

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; labelKey: TranslationKey }> = [
  { value: "system", labelKey: "appearance.themeSystem" },
  { value: "light", labelKey: "appearance.themeLight" },
  { value: "dark", labelKey: "appearance.themeDark" },
];

/** Scope the accent variables to one card, so its LILO mark paints in that palette. */
function paletteStyle(colors: AccentColors): CSSProperties {
  return {
    "--accent": colors.from,
    "--accent2": colors.to,
  } as CSSProperties;
}

interface PaletteCardProps {
  id: AccentKey;
  colors: AccentColors;
  label: string;
  selected: boolean;
  onSelect: (id: AccentKey) => void;
}

function PaletteCard({ id, colors, label, selected, onSelect }: PaletteCardProps) {
  return (
    <button
      type="button"
      className={`palette${selected ? " on" : ""}`}
      style={paletteStyle(colors)}
      aria-pressed={selected}
      onClick={() => onSelect(id)}
    >
      <span className="palette-art" aria-hidden>
        <Logo size={34} />
      </span>
      <span className="palette-name">{label}</span>
    </button>
  );
}

export function AppearanceSection() {
  const { t } = useTranslation();
  const theme = useDraftPreference("theme");
  const accent = useDraftPreference("accent");
  const customAccent = useDraftPreference("customAccent");
  const viz = useDraftPreference("viz");
  const animations = useDraftPreference("animations");
  const bargeIn = useDraftPreference("bargeIn");
  const sensitivity = useDraftPreference("bargeInSensitivity");
  const setPreference = useSettingsDraft((s) => s.setPreference);
  // The companion is a window style Rust owns, not a draft preference: it
  // applies at once, like the same switch in the menu bar and the tray.
  const companion = useShellStyle((s) => s.style === "companion");
  const setCompanion = useShellStyle((s) => s.setCompanion);

  const toggleBargeIn = (next: boolean) => setPreference("bargeIn", next);

  const changeSensitivity = (value: number) => setPreference("bargeInSensitivity", value);

  const setCustom = (patch: Partial<AccentColors>) => {
    setPreference("customAccent", { ...customAccent, ...patch });
    if (accent !== "custom") setPreference("accent", "custom");
  };

  return (
    <>
      <Section title={t("appearance.look")}>
        <div className="stack">
          <div>
            <span className="field-label">{t("appearance.theme")}</span>
            <SegmentedControl<ThemeMode>
              label={t("appearance.theme")}
              value={theme}
              options={THEME_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onChange={(next) => setPreference("theme", next)}
            />
          </div>

          <div>
            <span className="field-label">{t("appearance.palette")}</span>
            <div className="palette-grid" role="group" aria-label={t("appearance.palette")}>
              {PALETTE_KEYS.map((key) => (
                <PaletteCard
                  key={key}
                  id={key}
                  colors={ACCENTS[key]}
                  label={t(`palette.${key}` as TranslationKey)}
                  selected={accent === key}
                  onSelect={(id) => setPreference("accent", id)}
                />
              ))}
              <PaletteCard
                id="custom"
                colors={customAccent}
                label={t("palette.custom")}
                selected={accent === "custom"}
                onSelect={(id) => setPreference("accent", id)}
              />
            </div>
            <p className="field-help">{t("appearance.paletteHelp")}</p>
          </div>

          {accent === "custom" && (
            <div className="palette-custom">
              <label className="color-field">
                <input
                  type="color"
                  value={customAccent.from}
                  onChange={(event) => setCustom({ from: event.target.value })}
                />
                <span>{t("appearance.colorFrom")}</span>
                <code>{customAccent.from}</code>
              </label>
              <label className="color-field">
                <input
                  type="color"
                  value={customAccent.to}
                  onChange={(event) => setCustom({ to: event.target.value })}
                />
                <span>{t("appearance.colorTo")}</span>
                <code>{customAccent.to}</code>
              </label>
            </div>
          )}

          {hostPort()?.features?.voicePreferences !== false && <div>
            <span className="field-label">{t("appearance.visualizer")}</span>
            <SegmentedControl<VizMode>
              variant="choices"
              label={t("appearance.visualizer")}
              value={viz}
              options={VIZ_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              onChange={(next) => setPreference("viz", next)}
            />
          </div>}

          {hostPort()?.features?.animations !== false && <><div className="row between">
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {t("appearance.animations")}
            </span>
            <Switch
              checked={animations}
              onChange={(next) => setPreference("animations", next)}
              label={t("appearance.animations")}
            />
          </div>
          <p className="field-help">{t("appearance.animationsHelp")}</p></>}

          {isTauri() && (
            <>
              <div className="row between">
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {t("appearance.companion")}
                </span>
                <Switch
                  checked={companion}
                  onChange={(next) => void setCompanion(next)}
                  label={t("appearance.companion")}
                />
              </div>
              <p className="field-help">{t("appearance.companionHelp")}</p>
            </>
          )}
        </div>
      </Section>

      {hostPort()?.features?.voicePreferences !== false && <Section title={t("appearance.interaction")}>
        <div className="stack">
          <div className="row between">
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {t("appearance.bargeIn")}
            </span>
            <Switch
              checked={bargeIn}
              onChange={toggleBargeIn}
              label={t("appearance.bargeIn")}
            />
          </div>
          <p className="field-help">{t("appearance.bargeInHelp")}</p>
          <RangeSlider
            label={t("appearance.sensitivity")}
            value={sensitivity}
            unit="%"
            help={t("appearance.sensitivityHelp")}
            onChange={changeSensitivity}
          />
        </div>
      </Section>}
    </>
  );
}
