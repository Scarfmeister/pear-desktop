import { z } from '@hono/zod-openapi';

import { VolumePercentageSchema } from '@/utils/volume';

export const SetVolumeSchema = z.object({
  volume: VolumePercentageSchema,
});
