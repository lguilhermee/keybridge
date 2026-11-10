import { defineProvider } from "cursor-byok:provider";
import { devinChannel } from "./channel.ts";
import {
  credentialImport,
  devinBrowserOAuth,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProvider({
  channels: [devinChannel],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "Devin accounts", "zh-CN": "Devin 账号" },
    add: [devinBrowserOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
