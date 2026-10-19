import { createRoot } from "react-dom/client";
import { installHostPort } from "../../lib/hostPort";
import { applyPreferences, usePreferencesStore } from "../../store/preferencesStore";
import { DaemonHost } from "./daemonHost";
import { DaemonShell } from "./DaemonShell";
import "../../styles/index.css";
import "./daemon.css";

const supplied = location.hash.slice(1);
if (/^[a-f0-9]{64}(\.[a-f0-9]{64})?$/.test(supplied)) {
  const [token, key] = supplied.split(".");
  sessionStorage.setItem("lilo/daemon-token", token);
  if (key) sessionStorage.setItem("lilo/daemon-key", key);
  else sessionStorage.removeItem("lilo/daemon-key");
  history.replaceState(null, "", location.pathname);
}
const token = sessionStorage.getItem("lilo/daemon-token");
const host = token ? new DaemonHost(token, sessionStorage.getItem("lilo/daemon-key") ?? undefined) : null;
if (host) installHostPort(host);
document.documentElement.dataset.shell = "classic";
document.documentElement.dataset.host = "daemon";
usePreferencesStore.setState({ animations: false });
applyPreferences(usePreferencesStore.getState());
const root = document.getElementById("root");
if (!root) throw new Error("Daemon root is missing.");
createRoot(root).render(<DaemonShell host={host}/>);
