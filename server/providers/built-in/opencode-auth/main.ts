import { defineProvider } from "cursor-byok:provider";
import { opencodeChannel } from "./channel.ts";
import { opencodeFreeChannel } from "./free.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProvider({
  channels: [opencodeChannel, opencodeFreeChannel],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "OpenCode Go accounts", "zh-CN": "OpenCode Go 账号" },
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
