import { isTauri, runTool } from "../../lib/gateway";
import { log } from "../../lib/log";

/** How often the device is asked again. */
const EVERY_MS = 30 * 60 * 1000;

/**
 * Report the device's position to the location plugin.
 *
 * The WebView's geolocation is the platform location service (Windows location,
 * CoreLocation where the WebView allows it). When it is unavailable or denied
 * the plugin falls back to the network on its own, so failure here is quiet.
 */
function reportOnce(): void {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      void runTool("location_report", {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }).catch(() => {
        /* no location plugin loaded */
      });
    },
    (error) => log("location", `device location unavailable: ${error.message}`),
    { enableHighAccuracy: false, timeout: 15_000, maximumAge: EVERY_MS },
  );
}

/** Start reporting. Returns the cleanup. */
export function startDeviceLocation(): () => void {
  if (!isTauri()) return () => {};
  reportOnce();
  const timer = setInterval(reportOnce, EVERY_MS);
  return () => clearInterval(timer);
}
