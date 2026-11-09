import { defineProviderPlugin } from "cursor-byok:plugin";
import { opencodeProvider } from "./provider.ts";
import { opencodeFreeProvider } from "./free.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [opencodeProvider, opencodeFreeProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "OpenCode Go accounts", "zh-CN": "OpenCode Go 账号" },
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
