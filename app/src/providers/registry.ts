/**
 * The composition root for voice backends: the one list that knows which
 * adapters exist. Removing a line uninstalls that backend; core is unaffected.
 */
import { chatgptProvider } from "./chatgpt/definition";
import { claudeProvider } from "./claude/definition";
import { grokProvider } from "./grok/definition";
import { registerProvider } from "./contract";
import { mockProvider } from "./mock/definition";

registerProvider(mockProvider);
registerProvider(chatgptProvider);
registerProvider(claudeProvider);
registerProvider(grokProvider);
