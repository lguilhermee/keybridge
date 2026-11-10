import { defineProvider } from "cursor-byok:provider";
import { grokDeviceOAuth } from "./oauth.ts";
import { grokChannel } from "./channel.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProvider({
  channels: [grokChannel],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "Grok accounts", "zh-CN": "Grok 账号" },
    add: [grokDeviceOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
