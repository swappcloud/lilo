import { afterEach, describe, expect, it } from "vitest";
import source from "../../../src-tauri/src/shell.rs?raw";

let dispose: (() => void) | undefined;
afterEach(() => dispose?.());
describe("native WebView context menu", () => {
  it("blocks the browser menu while allowing LILO's own menu handler", () => {
    const script = source.match(/const APP_CONTEXT_MENU_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
    expect(script).toBeDefined();
    const events: Array<[string, EventListener, boolean]> = [];
    const target = {
      addEventListener: (name: string, handler: EventListener, capture: boolean) => {
        events.push([name, handler, capture]);
        document.addEventListener(name, handler, capture);
      },
    };
    new Function("document", script!)(target);
    dispose = () => events.forEach(([name, handler, capture]) => document.removeEventListener(name, handler, capture));
    const button = document.createElement("button");
    document.body.append(button);
    let ownMenu = false;
    button.addEventListener("contextmenu", () => { ownMenu = true; });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(button.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(ownMenu).toBe(true);
    button.remove();
  });
});
