import { defineProvider } from "cursor-byok:provider";
import { claudeChannel } from "./channel.ts";
import {
  claudeBrowserOAuth,
  credentialImport,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProvider({
  channels: [claudeChannel],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "Claude accounts", "zh-CN": "Claude 账号" },
    add: [claudeBrowserOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
