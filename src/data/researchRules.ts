import type { GameDifficulty } from '../types/globalSettings';

export const BLOCKED_RESEARCH_SEEDS: Record<GameDifficulty, readonly string[]> = {
  normal: [],
  hard: [
    's_energy_hand_crank',
    's_energy_wind_turbine_1',
    's_energy_geothermal_plant',
    's_energy_solar_panel_2',
  ],
  impossible: [
    's_production_advanced_copper_extraction',
    's_production_advanced_coal_extraction',
    's_energy_hand_crank',
    's_energy_wind_turbine_1',
    's_energy_geothermal_plant',
    's_energy_lv_pole',
    's_energy_energy_storage',
    's_energy_solar_panel_2',
    's_utility_scrubber',
    's_utility_gold_item_storage_silo',
    's_utility_gold_fluid_storage_silo',
  ],
  impossible2: [
    's_production_advanced_copper_extraction',
    's_production_advanced_coal_extraction',
    's_energy_hand_crank',
    's_energy_wind_turbine_1',
    's_energy_geothermal_plant',
    's_energy_lv_pole',
    's_energy_energy_storage',
    's_energy_solar_panel_2',
    's_utility_scrubber',
    's_utility_gold_item_storage_silo',
    's_utility_gold_fluid_storage_silo',
  ],
  sandbox: [],
  sandbox_plus: [],
};

export function getBlockedResearchIds(
  difficulty: GameDifficulty,
  dependentsById: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const blocked = new Set<string>();
  const pending = [...BLOCKED_RESEARCH_SEEDS[difficulty]];

  while (pending.length > 0) {
    const researchId = pending.pop();
    if (!researchId || blocked.has(researchId)) continue;
    blocked.add(researchId);
    pending.push(...(dependentsById.get(researchId) ?? []));
  }

  return blocked;
}
