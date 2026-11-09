import { defineProviderPlugin } from "cursor-byok:plugin";
import { claudeProvider } from "./provider.ts";
import {
  claudeBrowserOAuth,
  credentialImport,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProviderPlugin({
  providers: [claudeProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "Claude accounts", "zh-CN": "Claude 账号" },
    add: [claudeBrowserOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
