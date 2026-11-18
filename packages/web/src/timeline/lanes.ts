import { enumCodec } from '../lib/queryState';
import { LANE_MODES } from './layout';
import type { LaneMode } from './layout';

export const LANE_MODE_LABEL: Record<LaneMode, string> = {
  none: 'Single',
  type: 'By type',
  participant: 'By person',
};
/** Query key `lanes`. */
export const laneModeCodec = enumCodec(LANE_MODES);
