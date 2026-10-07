// Where the text of a resume, a need or a vacancy goes when it is sent now (docs/models.md, «Три режима»): the people
// who write it are told before they send it. The same rules as the adapter decide: the configuration, the key an
// external runtime requires, and the administrator's switch.
import type { ExtractRoute } from '$lib/components/product/model';
import type { ExtractConfig } from '$lib/server/config';
import type { ModelModes } from './modes';
import { lacksApiKey, RUNTIME_PROFILES } from './runtime';

export async function extractRoute(
	settings: ExtractConfig | null,
	modes: Pick<ModelModes, 'current'>
): Promise<ExtractRoute> {
	if (!settings || lacksApiKey(settings)) return { kind: 'none' };
	// A mode store that cannot be read makes the adapter answer `unavailable`: the rules read the text then.
	const mode = await modes.current('extract');
	if (!mode.ok || mode.value === 'off') return { kind: 'none' };
	return { kind: RUNTIME_PROFILES[settings.runtime].hosting, model: settings.model };
}
