import { defineProvider } from "cursor-byok:provider";
import { antigravityAuthorizationCodeOAuth } from "./oauth.ts";
import { antigravityChannel } from "./channel.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProvider({
  channels: [antigravityChannel],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: {
      "en-US": "Google accounts & API keys",
      "zh-CN": "Google 账号与 API 密钥",
    },
    add: [antigravityAuthorizationCodeOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
