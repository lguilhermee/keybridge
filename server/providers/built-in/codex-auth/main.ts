import { defineProvider } from "cursor-byok:provider";
import { codexDeviceOAuth } from "./oauth.ts";
import { codexChannel } from "./channel.ts";
import {
  consumeResetCardAction,
  credentialImport,
  listResetCardsAction,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProvider({
  channels: [codexChannel],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: { "en-US": "ChatGPT accounts", "zh-CN": "ChatGPT 账号" },
    add: [codexDeviceOAuth],
    import: credentialImport,
    present: presentAccount,
    actions: [listResetCardsAction, consumeResetCardAction],
    refresh: refreshAccount,
  }],
});
