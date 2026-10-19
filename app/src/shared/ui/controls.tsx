import { useId, type ReactNode } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    />
  );
}

interface SegmentedControlProps<T extends string> {
  variant?: "segmented" | "choices";
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}

export function SegmentedControl<T extends string>({
  variant = "segmented",
  value,
  options,
  onChange,
  label,
}: SegmentedControlProps<T>) {
  return (
    <div className={variant === "choices" ? "choice-tags" : "seg"} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "on" : ""}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface RangeSliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  unit?: string;
  help?: string;
}

export function RangeSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  unit = "",
  help,
}: RangeSliderProps) {
  const id=useId();
  const display=(number:number)=>`${number}${unit}`;
  return (
    <label className="slider">
      <span className="slider-heading"><span>{label}</span><output htmlFor={id} className="slider-current-value">{display(value)}</output></span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={display(value)}
        aria-describedby={help?`${id}-help`:undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="slider-bounds" aria-hidden><span>{display(min)}</span><span>{display(max)}</span></span>
      {help&&<span className="field-help" id={`${id}-help`}>{help}</span>}
    </label>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  help?: string;
  placeholder?: string;
  /** Rendered before the label — a mark, a swatch, a badge. */
  leading?: ReactNode;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
  help,
  placeholder,
  leading,
}: SelectFieldProps) {
  return (
    <label>
      <span className="field-label">
        {leading}
        {label}
      </span>
      <select
        className="field"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {help && <span className="field-help">{help}</span>}
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  help?: string;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  help,
  multiline = false,
  rows = 3,
  disabled,
}: TextFieldProps) {
  return (
    <label>
      <span className="field-label">{label}</span>
      {multiline ? (
        <textarea
          className="field"
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="field"
          type={type}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {help && <span className="field-help">{help}</span>}
    </label>
  );
}
