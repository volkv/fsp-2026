import { describe, expect, it } from 'vitest';
import { modelReadingLabel } from './model';

describe('the mode a reading was made in', () => {
	it('says a kept answer of the model was given again without a call', () => {
		const live = modelReadingLabel({ modelId: 'claude-haiku', runtime: 'api', cached: false });
		expect(live.label).toBe('Внешняя модель');
		const kept = modelReadingLabel({ modelId: 'claude-haiku', runtime: 'api', cached: true });
		expect(kept.label).toBe('Внешняя модель, из сохранённого разбора');
		expect(kept.hint).toContain('сейчас модель не вызывалась');
	});
});
