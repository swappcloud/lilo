import { useToastStore } from "../../store/toastStore";

export function Toast() {
  const message = useToastStore((s) => s.message);
  return (
    <div className={`toast glass${message ? " show" : ""}`} role="status" aria-live="polite">
      {message ?? ""}
    </div>
  );
}
