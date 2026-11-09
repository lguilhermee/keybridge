import { defineProviderPlugin } from "cursor-byok:plugin";
import { devinProvider } from "./provider.ts";
import {
  credentialImport,
  devinBrowserOAuth,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProviderPlugin({
  providers: [devinProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "Devin accounts", "zh-CN": "Devin 账号" },
    add: [devinBrowserOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
