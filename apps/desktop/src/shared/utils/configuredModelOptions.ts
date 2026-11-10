import { providerText, type Model, type ProviderDescriptor } from "../api";
import type { ModelSelectOption } from "../ui/ModelSelect";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../ui/icons";
import { modelProviderName } from "./modelProvider";

/** ModelSelect options for every configured model: API-key models by `model_hash`, provider models by `provider:` id. */
export function configuredModelOptions(models: Model[], providers: ProviderDescriptor[], locale: string): ModelSelectOption[] {
  const options: ModelSelectOption[] = models.map((model) => ({
    value: model.model_hash,
    label: model.display_name && model.display_name !== model.model_id
      ? `${model.display_name} (${model.model_id})`
      : model.display_name || model.model_id,
    group: modelProviderName(model),
    icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
  }));
  for (const provider of providers) {
    for (const channel of provider.channels) {
      if (!channel.configured) continue;
      const group = providerText(channel.displayName, locale) || provider.name;
      for (const model of channel.models.filter((model) => model.enabled)) {
        options.push({
          value: model.id,
          label: model.displayName,
          group,
          iconSrc: model.icon || undefined,
          icon: model.icon ? undefined : flatColorOrganizationIcon,
        });
      }
    }
  }
  return options;
}
